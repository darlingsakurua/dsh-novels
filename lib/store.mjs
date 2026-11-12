/**
 * dsh-novels — Host storage layer.
 *
 * Everything the plugin knows lives under `<profileDir>/plugin-data/dsh-novels`:
 *
 *   library.json                        index + prefs + reading progress
 *   books/<title>.txt                   normalized UTF-8 body of one book
 *   books/<title>.chapters.json         [{i, title, start}] offsets into the body
 *
 * The body is named after the book title, so the folder the "Location" button
 * opens reads like a bookshelf. The exact name is stored on the book record
 * (`fileName`): titles repeat, illegal path characters and Windows reserved
 * names must be replaced, so `<title>.txt` alone is not unique or safe.
 *
 * Writes are always "temp file in the same directory + rename", so a crash
 * mid-write leaves the previous file intact instead of a half-written one.
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, join, sep } from 'node:path'

export const LIBRARY_VERSION = 1

/** Reader defaults; every field is user-tunable through `PATCH /prefs`. */
export const DEFAULT_PREFS = Object.freeze({
  fontSize: 18,
  lineHeight: 1.9,
  measure: 720,
  fontFamily: 'serif',
})

/** Book ids are the only untrusted value that reaches a filesystem path. */
const BOOK_ID = /^b_[0-9a-f]{8}$/

export const PREFS_BOUNDS = Object.freeze({
  fontSize: { min: 12, max: 34 },
  lineHeight: { min: 1.2, max: 2.6 },
  measure: { min: 480, max: 1200 },
})

export function isBookId(value) {
  return typeof value === 'string' && BOOK_ID.test(value)
}

/** Characters Windows/macOS/Linux file systems reject, plus control bytes. */
const ILLEGAL_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g
/** Same class without `g`: `test()` on a global regex is stateful. */
const HAS_ILLEGAL_FILE_CHAR = /[\\/:*?"<>|\u0000-\u001f]/
const RESERVED_FILE_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
])
export const MAX_FILE_STEM = 100

/**
 * Turn a book title into a portable `<stem>.txt`. Everything path-unsafe is
 * removed here, so a title can never escape `books/` no matter what the client
 * sends; the caller still uniquifies the result.
 */
export function fileNameFor(title) {
  let stem = typeof title === 'string' ? title : ''
  stem = stem.normalize('NFC').replace(ILLEGAL_FILE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  // Windows strips trailing dots/spaces and refuses names starting with a dot.
  stem = stem.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  if (RESERVED_FILE_STEMS.has(stem.split('.')[0].toLowerCase())) stem = `_${stem}`
  if (stem.length > MAX_FILE_STEM) stem = stem.slice(0, MAX_FILE_STEM).trim()
  if (!stem) stem = '未命名'
  return `${stem}.txt`
}

/** A `fileName` is only trusted after it proves it is a plain name. */
function isSafeFileName(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_FILE_STEM + 20 &&
    basename(value) === value &&
    !value.includes('..') &&
    !HAS_ILLEGAL_FILE_CHAR.test(value) &&
    /\.txt$/i.test(value)
  )
}

export function emptyLibrary() {
  return { version: LIBRARY_VERSION, prefs: { ...DEFAULT_PREFS }, books: [] }
}

export function createStore(dataDir) {
  return new Store(dataDir)
}

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.libraryPath = join(dataDir, 'library.json')
    this.booksDir = join(dataDir, 'books')
    this.cache = null
    mkdirSync(this.booksDir, { recursive: true })
    this.migrateFileNames()
  }

  /**
   * Older versions stored `books/<id>.txt`. Give those books a title-based file
   * name so the folder shows real names, and never lose the body if the rename
   * is refused (the index keeps pointing at the old name in that case).
   */
  migrateFileNames() {
    let library
    try {
      library = this.load()
    } catch {
      return
    }
    let changed = false
    for (const book of library.books) {
      if (isSafeFileName(book.fileName)) continue
      const legacy = join(this.booksDir, `${book.id}.txt`)
      // Already migrated by an earlier run? Adopt the file we find, if any.
      const adopted = this.existingTitleFile(book)
      book.fileName = adopted ?? this.uniqueFileName(fileNameFor(book.title), book.id)
      if (existsSync(legacy) && legacy !== this.filePath(book.fileName)) {
        try {
          this.moveFile(legacy, this.filePath(book.fileName))
          this.moveFile(join(this.booksDir, `${book.id}.chapters.json`), this.chaptersPathFor(book.fileName))
        } catch {
          book.fileName = `${book.id}.txt`
        }
      }
      changed = true
    }
    if (changed) {
      try {
        this.save(library)
      } catch {
        /* a read-only data dir must not stop the plugin from starting */
      }
    }
  }

  /** A file already sitting in `books/` under this book's title. */
  existingTitleFile(book) {
    const wanted = fileNameFor(book.title)
    const candidate = this.filePath(wanted)
    const owner = this.load().books.find((item) => item !== book && item.fileName === wanted)
    return existsSync(candidate) && !owner ? wanted : null
  }

  /* ------------------------------------------------------------- library -- */

  /**
   * The whole index. A corrupt `library.json` is moved aside as
   * `library.json.bad` and replaced by an empty shelf: a broken index must
   * degrade to "no books", never to a white screen.
   */
  load() {
    if (this.cache) return this.cache
    let raw = null
    try {
      raw = readFileSync(this.libraryPath, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.cache = emptyLibrary()
      return this.cache
    }
    try {
      this.cache = normalizeLibrary(JSON.parse(raw))
    } catch {
      this.backupBrokenLibrary()
      this.cache = emptyLibrary()
    }
    return this.cache
  }

  backupBrokenLibrary() {
    try {
      renameSync(this.libraryPath, `${this.libraryPath}.bad`)
    } catch {
      /* the backup is best effort; the empty library still loads */
    }
  }

  save(library) {
    this.cache = library
    writeJsonAtomic(this.libraryPath, library)
  }

  listBooks() {
    const library = this.load()
    return [...library.books].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  }

  prefs() {
    return this.load().prefs
  }

  getBook(id) {
    const library = this.load()
    return library.books.find((book) => book.id === id) ?? null
  }

  /* ---------------------------------------------------------------- books -- */

  /**
   * Persist one uploaded book: body, chapter offsets, then the index entry.
   * The index is written last, so a crash leaves at worst an orphan file that
   * the next upload of the same id would overwrite (ids are random).
   */
  createBook({ name, text, encoding, chapters, author = '' }) {
    const body = normalizeText(text)
    if (!body.trim()) throw new StoreError('empty-text', '正文为空，无法导入')

    const normalized = normalizeChapters(chapters, body.length)
    const id = newBookId()
    const now = new Date().toISOString()
    const title = cleanTitle(name, normalized)
    const fileName = this.uniqueFileName(fileNameFor(title), null)

    writeTextAtomic(this.filePath(fileName), body)
    writeJsonAtomic(this.chaptersPathFor(fileName), { chapters: normalized })

    const book = {
      id,
      title,
      fileName,
      author: typeof author === 'string' ? author.trim().slice(0, 120) : '',
      sourceName: typeof name === 'string' ? name.slice(0, 260) : '',
      encoding: typeof encoding === 'string' ? encoding.slice(0, 40) : 'UTF-8',
      chars: body.length,
      chapterCount: normalized.length,
      createdAt: now,
      updatedAt: now,
      progress: { chapterIndex: 0, offsetChars: 0, percent: 0, updatedAt: now },
    }

    const library = this.load()
    library.books.push(book)
    this.save(library)
    return book
  }

  readText(id) {
    return readFileSync(this.textPath(id), 'utf8')
  }

  readChapters(id) {
    const parsed = JSON.parse(readFileSync(this.chaptersPath(id), 'utf8'))
    return Array.isArray(parsed?.chapters) ? parsed.chapters : []
  }

  updateBook(id, patch) {
    const library = this.load()
    const book = library.books.find((item) => item.id === id)
    if (!book) return null
    if (typeof patch.title === 'string' && patch.title.trim()) {
      const nextTitle = patch.title.trim().slice(0, 160)
      if (nextTitle !== book.title) {
        // The body file follows the title; a failed rename aborts the edit so
        // the index never claims a name the disk does not have.
        const nextFileName = this.uniqueFileName(fileNameFor(nextTitle), book.id)
        if (nextFileName !== book.fileName) this.renameBookFiles(book, nextFileName)
        book.title = nextTitle
        book.fileName = nextFileName
      }
    }
    if (typeof patch.author === 'string') book.author = patch.author.trim().slice(0, 120)
    book.updatedAt = new Date().toISOString()
    this.save(library)
    return book
  }

  /** Move both files of a book to a new title-based name. */
  renameBookFiles(book, nextFileName) {
    const from = this.filePath(book.fileName ?? `${book.id}.txt`)
    const to = this.filePath(nextFileName)
    try {
      this.moveFile(from, to)
      this.moveFile(this.chaptersPathFor(book.fileName ?? `${book.id}.txt`), this.chaptersPathFor(nextFileName))
    } catch (error) {
      if (error instanceof StoreError) throw error
      throw new StoreError(
        'rename-failed',
        `无法重命名文件: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  updateProgress(id, { chapterIndex, offsetChars, percent }) {
    const library = this.load()
    const book = library.books.find((item) => item.id === id)
    if (!book) return null

    const lastChapter = Math.max(0, book.chapterCount - 1)
    const chapter = clampInt(chapterIndex, 0, lastChapter, 0)
    const offset = clampInt(offsetChars, 0, 10_000_000, 0)
    const ratio = typeof percent === 'number' && Number.isFinite(percent) ? Math.min(1, Math.max(0, percent)) : 0

    book.progress = { chapterIndex: chapter, offsetChars: offset, percent: ratio, updatedAt: new Date().toISOString() }
    book.updatedAt = book.progress.updatedAt
    this.save(library)
    return book
  }

  deleteBook(id) {
    const library = this.load()
    const index = library.books.findIndex((item) => item.id === id)
    if (index === -1) return false
    const [book] = library.books.splice(index, 1)
    this.save(library)
    const paths = [
      book?.fileName ? this.filePath(book.fileName) : null,
      book?.fileName ? this.chaptersPathFor(book.fileName) : null,
      // Legacy names, in case the index was migrated while the file was not.
      join(this.booksDir, `${id}.txt`),
      join(this.booksDir, `${id}.chapters.json`),
    ]
    for (const path of paths) {
      if (!path) continue
      try {
        removeFile(path)
      } catch {
        /* the index is already authoritative; a stray file is harmless */
      }
    }
    return true
  }

  updatePrefs(patch) {
    const library = this.load()
    library.prefs = sanitizePrefs({ ...library.prefs, ...patch })
    this.save(library)
    return library.prefs
  }

  /* ---------------------------------------------------------------- paths -- */

  /** Absolute path of a file inside `books/`, refusing anything that escapes. */
  filePath(fileName) {
    if (!isSafeFileName(fileName)) throw new StoreError('invalid-id', '非法的文件名')
    const path = join(this.booksDir, fileName)
    if (!path.startsWith(this.booksDir + sep)) throw new StoreError('invalid-id', '非法的文件名')
    return path
  }

  chaptersPathFor(fileName) {
    // Validate through filePath (it checks the whole path), then swap the suffix.
    return this.filePath(fileName).replace(/\.txt$/i, '.chapters.json')
  }

  /** `<title>.txt` never collides with another book or an orphan file. */
  uniqueFileName(desired, ignoreId) {
    const taken = new Set(
      this.load()
        .books.filter((book) => book.id !== ignoreId && book.fileName)
        .map((book) => String(book.fileName).toLowerCase()),
    )
    const stem = desired.replace(/\.txt$/i, '')
    for (let n = 1; n < 500; n += 1) {
      const candidate = n === 1 ? desired : `${stem} (${n}).txt`
      if (taken.has(candidate.toLowerCase())) continue
      if (existsSync(join(this.booksDir, candidate))) continue
      return candidate
    }
    return `${stem} (${Date.now()}).txt`
  }

  textPath(id) {
    if (!isBookId(id)) throw new StoreError('invalid-id', '非法的书籍 id')
    const book = this.getBook(id)
    return this.filePath(book?.fileName ?? `${id}.txt`)
  }

  chaptersPath(id) {
    if (!isBookId(id)) throw new StoreError('invalid-id', '非法的书籍 id')
    const book = this.getBook(id)
    return this.chaptersPathFor(book?.fileName ?? `${id}.txt`)
  }

  /** Rename with a copy fallback: some Windows setups refuse rename across handles. */
  moveFile(from, to) {
    if (!existsSync(from)) return
    if (from === to) return
    try {
      renameSync(from, to)
    } catch {
      writeFileSync(to, readFileSync(from))
      removeFile(from)
    }
  }

  /** True when the index entry exists but its body file went missing. */
  hasBody(id) {
    return isBookId(id) && existsSync(this.textPath(id))
  }
}

export class StoreError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'StoreError'
    this.code = code
  }
}

/* ------------------------------------------------------------- internals -- */

function newBookId() {
  return `b_${randomBytes(4).toString('hex')}`
}

function normalizeLibrary(parsed) {
  const library = emptyLibrary()
  if (!parsed || typeof parsed !== 'object') return library
  library.prefs = sanitizePrefs(parsed.prefs)
  if (!Array.isArray(parsed.books)) return library

  for (const raw of parsed.books) {
    if (!raw || typeof raw !== 'object' || !isBookId(raw.id)) continue
    library.books.push({
      id: raw.id,
      title: typeof raw.title === 'string' && raw.title ? raw.title.slice(0, 160) : '未命名',
      ...(isSafeFileName(raw.fileName) ? { fileName: raw.fileName } : {}),
      author: typeof raw.author === 'string' ? raw.author.slice(0, 120) : '',
      sourceName: typeof raw.sourceName === 'string' ? raw.sourceName.slice(0, 260) : '',
      encoding: typeof raw.encoding === 'string' ? raw.encoding.slice(0, 40) : 'UTF-8',
      chars: clampInt(raw.chars, 0, 200_000_000, 0),
      chapterCount: clampInt(raw.chapterCount, 1, 100_000, 1),
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
      progress: sanitizeProgress(raw.progress),
    })
  }
  return library
}

function sanitizeProgress(progress) {
  const now = new Date().toISOString()
  if (!progress || typeof progress !== 'object') {
    return { chapterIndex: 0, offsetChars: 0, percent: 0, updatedAt: now }
  }
  return {
    chapterIndex: clampInt(progress.chapterIndex, 0, 100_000, 0),
    offsetChars: clampInt(progress.offsetChars, 0, 10_000_000, 0),
    percent: typeof progress.percent === 'number' && Number.isFinite(progress.percent)
      ? Math.min(1, Math.max(0, progress.percent))
      : 0,
    updatedAt: typeof progress.updatedAt === 'string' ? progress.updatedAt : now,
  }
}

export function sanitizePrefs(input) {
  const prefs = { ...DEFAULT_PREFS }
  if (!input || typeof input !== 'object') return prefs
  for (const key of Object.keys(PREFS_BOUNDS)) {
    const bounds = PREFS_BOUNDS[key]
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value)) {
      prefs[key] = Math.min(bounds.max, Math.max(bounds.min, value))
    }
  }
  if (input.fontFamily === 'serif' || input.fontFamily === 'sans') prefs.fontFamily = input.fontFamily
  return prefs
}

/** `\r\n` → `\n`, drop NULs and BOM: the offset base the client also uses. */
export function normalizeText(text) {
  if (typeof text !== 'string') throw new StoreError('invalid-text', '正文必须是字符串')
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '')
}

function normalizeChapters(chapters, length) {
  const list = []
  if (Array.isArray(chapters)) {
    const candidates = []
    for (const raw of chapters) {
      const start = Math.trunc(Number(raw?.start))
      if (!Number.isFinite(start) || start < 0 || start >= length) continue
      const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 120) : '正文'
      candidates.push({ start, title })
    }
    // The client already sends sorted offsets; sorting again makes the store
    // tolerant of hand-written or older payloads without trusting them.
    candidates.sort((a, b) => a.start - b.start)
    for (const candidate of candidates) {
      if (list.length && candidate.start <= list[list.length - 1].start) continue
      list.push(candidate)
    }
  }
  if (!list.length) list.push({ title: '全文', start: 0 })
  list[0] = { ...list[0], start: 0 }
  return list.map((chapter, i) => ({ i, title: chapter.title, start: chapter.start }))
}

function cleanTitle(name, chapters) {
  const base = typeof name === 'string' ? name.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').trim() : ''
  if (base) return base.slice(0, 160)
  const first = chapters[0]?.title ?? ''
  return first && first !== '全文' ? first.slice(0, 160) : '未命名'
}

function clampInt(value, min, max, fallback) {
  const number = Math.trunc(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, number))
}

function writeJsonAtomic(path, value) {
  writeTextAtomic(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Same-directory temp file + rename: the reader never sees a partial file. */
function writeTextAtomic(path, text) {
  const temp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      removeFile(temp)
    } catch {
      /* the temp file may never have been created */
    }
    if (error?.code === 'ENOSPC') throw new StoreError('disk-full', '磁盘空间不足，写入失败')
    throw new StoreError('write-failed', `写入失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * `rmSync(..., { force: true })` can fail silently on Windows when the file is
 * held by an antivirus/indexer; `unlinkSync` surfaces the real error instead.
 */
function removeFile(path) {
  try {
    unlinkSync(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
