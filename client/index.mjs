/**
 * dsh-novels — Client half (web platform), Phase 1.
 *
 * Two views behind one sidebar entry: a shelf that lists imported books and
 * takes `.txt` uploads, and a reader that shows one chapter at a time with a
 * table of contents, previous/next chapter, and font size / line height.
 *
 * The bundle is loaded through `window.__ModuleLoader__`, which only hands out
 * a few pre-registered modules (React and friends) — relative ESM imports are
 * not available at runtime. The text decoding and chapter splitting therefore
 * live in this file as pure functions, and are exported through `testHooks` so
 * Node can exercise them without a browser.
 *
 * The page is served from the shell origin (`dsh-app://app/` in the desktop
 * app), so API paths are resolved against `document.baseURI`, not a host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-novels',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-novels'
    const SLOT_ID = 'novels'
    /** Relative to `document.baseURI`, so the request stays same-origin. */
    const API_BASE = 'dsh-novels/api/v1'
    /** Product limit for one book (the Host allows a little more on the wire). */
    const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
    /** Files are read in slices so the UI can show progress instead of freezing. */
    const UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024
    /** Above this many chapters the table of contents collapses into groups. */
    const TOC_GROUP_THRESHOLD = 300
    const TOC_GROUP_SIZE = 100
    /** Readable measure (the text column) bounds, in CSS pixels. */
    const MIN_MEASURE = 480
    const MAX_MEASURE = 1200
    const MEASURE_STEP = 40
    /** Chapter headings shorter than this many characters merge into the one before. */
    const MIN_CHAPTER_CHARS = 200
    /** Books with no recognizable heading are split into blocks of this size. */
    const FALLBACK_BLOCK_CHARS = 4000
    /** Floor for the measured reader height, so a broken host layout stays usable. */
    const MIN_READER_HEIGHT = 240
    /** Two identical headings this close together are one chapter printed twice. */
    const DUPLICATE_HEADING_WINDOW = 300
    /**
     * The strip is a real scroll window: the whole chapter sits in the DOM and
     * keys move the scroll position by whole lines. Slicing the text at
     * character offsets used to cut sentences in half and skip ~200 characters
     * per step, so the reader lost their place.
     */
    const INLINE_SCROLL_LINES = 3
    /** Assumed line box, used when the host cannot measure the real line height. */
    const INLINE_LINE_FALLBACK = 22
    /**
     * Ceiling on how much chapter text enters the strip's DOM. A normal chapter
     * is a few thousand characters; this only guards against pathological files.
     */
    const INLINE_DOM_CHARS = 40000
    /**
     * The strip's size limits live on the element itself, not only in the
     * injected stylesheet. A stale or blocked sheet must never let one
     * chapter's text stretch the composer area over the conversation.
     *
     * Width, margins and fonts are not fixed here: they are copied from a real
     * transcript paragraph at mount (see `typographyFrom`), so the prose looks
     * exactly like the conversation around it.
     */
    const INLINE_BOX_STYLE = {
      position: 'relative',
      width: '100%',
      maxHeight: '8.4em',
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollbarWidth: 'none',
      overscrollBehavior: 'contain',
    }
    const INLINE_TEXT_STYLE = {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }
    /** Paragraph rhythm copied from the chat renderer: 16px between blocks. */
    const INLINE_PARAGRAPH_STYLE = { margin: '16px 0' }
    const INLINE_FIRST_PARAGRAPH_STYLE = { margin: '0 0 16px' }
    const INLINE_PICK_STYLE = {
      maxWidth: '720px',
      maxHeight: '190px',
      margin: '0 auto',
      padding: '4px 16px 6px',
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
    }
    /** Dock entry id of the inline strip (the composer row above the input). */
    const INLINE_SLOT_ID = 'reader'
    /**
     * Main-panel key of the full shelf view. The sidebar button keeps `SLOT_ID`
     * so the shipped icon stays where it is; that panel only toggles the strip.
     */
    const FULL_PANEL_KEY = 'novels-full'

    /**
     * Height to pin on the reader root: from its own top edge to the bottom of
     * the nearest clipping ancestor, never past the viewport, never below the
     * floor. Pure so the layout rule can be tested without a browser.
     */
    function fittedReaderHeight(ownTop, boxBottom, viewportHeight, min = MIN_READER_HEIGHT) {
      const limit = Number.isFinite(boxBottom) ? Math.min(boxBottom, viewportHeight) : viewportHeight
      return Math.max(min, Math.round(limit - ownTop))
    }

    const zh = {
      nav: '书架',
      panelTitle: '书架',
      upload: '导入 TXT',
      uploading: '正在导入…',
      empty: '书架还是空的',
      emptyHint: '把一个 .txt 文件拖到这里，或点上面的「导入 TXT」。支持 UTF-8 / GB18030 / UTF-16，单个文件最大 20 MB。',
      dropHere: '松开即可导入',
      books: '本',
      chapters: '章',
      chars: '字',
      open: '阅读',
      rename: '改名',
      renameSave: '保存',
      renameCancel: '取消',
      renamePlaceholder: '书名',
      remove: '删除',
      back: '返回书架',
      toc: '目录',
      closeToc: '收起目录',
      tocGroup: '共 {count} 章',
      prev: '上一章',
      next: '下一章',
      fontSize: '字号',
      lineHeight: '行距',
      measure: '宽度',
      loading: '正在读取…',
      loadFailed: '加载失败',
      importFailed: '导入失败',
      decodeFailed: '无法识别文件编码',
      emptyFile: '文件是空的',
      tooLarge: '文件超过 20 MB，暂不支持',
      notText: '只支持 .txt 文件',
      uploadingPercent: '正在导入… {percent}%',
      encodingLabel: '编码',
      sourceLabel: '来源',
      firstChapter: '已经是第一章',
      lastChapter: '已经是最后一章',
      readerHint: '←/PageUp 上一章 · →/PageDown 下一章 · j/k 滚屏 · Esc 返回 · Ctrl± 字号',
      retry: '重试',
      deleteConfirm: '确定删除《{title}》？正文与章节记录都会移除。',
      unread: '未读',
      progressAt: '读到第 {chapter} 章',
      reveal: '位置',
      revealDir: '打开文件夹',
      revealHint: '在文件管理器中显示这本书的 txt',
      storageAt: '存储位置',
      storageHint: '已上传的 txt 与章节索引都存在这里',
      revealFailed: '无法打开文件管理器',
      inlineOpen: '展开完整阅读',
      inlineEmpty: '书架还是空的',
    }

    const en = {
      nav: 'Novel shelf',
      panelTitle: 'Novel shelf',
      upload: 'Import TXT',
      uploading: 'Importing…',
      empty: 'The shelf is empty',
      emptyHint: 'Drop a .txt file here, or use “Import TXT”. UTF-8 / GB18030 / UTF-16 up to 20 MB.',
      dropHere: 'Release to import',
      books: 'books',
      chapters: 'chapters',
      chars: 'chars',
      open: 'Read',
      rename: 'Rename',
      renameSave: 'Save',
      renameCancel: 'Cancel',
      renamePlaceholder: 'Title',
      remove: 'Delete',
      back: 'Back to shelf',
      toc: 'Contents',
      closeToc: 'Hide contents',
      tocGroup: '{count} chapters',
      prev: 'Previous',
      next: 'Next',
      fontSize: 'Size',
      lineHeight: 'Leading',
      measure: 'Width',
      loading: 'Loading…',
      loadFailed: 'Load failed',
      importFailed: 'Import failed',
      decodeFailed: 'Unrecognized file encoding',
      emptyFile: 'The file is empty',
      tooLarge: 'Files above 20 MB are not supported yet',
      notText: 'Only .txt files are supported',
      uploadingPercent: 'Importing… {percent}%',
      encodingLabel: 'Encoding',
      sourceLabel: 'Source',
      firstChapter: 'Already at the first chapter',
      lastChapter: 'Already at the last chapter',
      readerHint: '←/PageUp previous · →/PageDown next · j/k scroll · Esc shelf · Ctrl± size',
      retry: 'Retry',
      deleteConfirm: 'Delete “{title}”? Its text and chapter map will be removed.',
      unread: 'Unread',
      progressAt: 'Chapter {chapter}',
      reveal: 'Location',
      revealDir: 'Open folder',
      revealHint: 'Show this book’s txt in the file manager',
      storageAt: 'Stored in',
      storageHint: 'Uploaded txt files and chapter maps live here',
      revealFailed: 'Could not open the file manager',
      inlineOpen: 'Open the full reader',
      inlineEmpty: 'The shelf is empty',
    }

    /* ------------------------------------------------------- text pipeline -- */

    /**
     * Decode raw bytes into a string. Order matters: a BOM wins, then strict
     * UTF-8, then the Chinese legacy encodings that novel `.txt` files use.
     * Returns the encoding label that was used, for display and bookkeeping.
     */
    function decodeBytes(input) {
      const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
      if (!bytes.length) return { text: '', encoding: 'UTF-8' }

      const startsWith = (...marks) => marks.every((value, i) => bytes[i] === value)

      if (startsWith(0xef, 0xbb, 0xbf)) {
        return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'UTF-8 (BOM)' }
      }
      if (startsWith(0xff, 0xfe)) {
        return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'UTF-16LE' }
      }
      if (startsWith(0xfe, 0xff)) {
        try {
          return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'UTF-16BE' }
        } catch {
          /* no utf-16be decoder: fall through to the byte-oriented decoders */
        }
      }

      try {
        return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
      } catch {
        /* not valid UTF-8, try the Chinese code pages below */
      }

      for (const label of ['gb18030', 'gbk', 'big5']) {
        try {
          const text = new TextDecoder(label, { fatal: true }).decode(bytes)
          return { text, encoding: label.toUpperCase() }
        } catch {
          /* keep trying */
        }
      }

      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8 (lossy)' }
    }

    /** One line ending, no BOM, no NUL padding — offsets depend on this. */
    function normalizeText(text) {
      return String(text ?? '')
        .replace(/\uFEFF/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\u0000/g, '')
    }

    const HEADING_PATTERNS = [
      // 第一章 / 第 12 回 / 第三卷 … up to 40 trailing characters of title.
      /^[ \t\u3000]*(第[0-9零一二三四五六七八九十百千万两〇]{1,8}[章节回卷篇部集][^\n]{0,40})$/gm,
      // Chapter 12 / Part IV / Book 3 …
      /^[ \t]*(chapter|part|book)\s+(?:[0-9]{1,4}|[ivxlcdm]{1,8})\b[^\n]{0,60}$/gim,
    ]

    /**
     * Split normalized text into chapters as `{title, start}` pairs. `start`
     * is a character offset into the text, so a chapter always reads as
     * `text.slice(start, nextStart)`. Returns at least one entry at offset 0.
     */
    function splitChapters(text) {
      const body = typeof text === 'string' ? text : ''
      if (!body.length) return [{ title: '全文', start: 0 }]

      const found = []
      for (const pattern of HEADING_PATTERNS) {
        pattern.lastIndex = 0
        let match
        while ((match = pattern.exec(body)) !== null) {
          const title = match[0].trim().replace(/\s+/g, ' ')
          if (title) found.push({ title, start: match.index })
          // A zero-width match would spin forever; the patterns cannot match
          // empty strings, but advance defensively anyway.
          if (match.index === pattern.lastIndex) pattern.lastIndex += 1
        }
      }
      found.sort((a, b) => a.start - b.start)

      const unique = []
      for (const chapter of found) {
        if (unique.length && chapter.start <= unique[unique.length - 1].start) continue
        unique.push(chapter)
      }

      // Many TXT files print the heading twice in a row ("第1章 X" on one line,
      // then the same line again). The second copy is not a chapter; keeping it
      // would either drop the real chapter as "too short" or leave the heading
      // text inside the body.
      const deduped = []
      for (const chapter of unique) {
        const previous = deduped[deduped.length - 1]
        if (
          previous &&
          previous.title === chapter.title &&
          chapter.start - previous.start <= DUPLICATE_HEADING_WINDOW
        ) {
          continue
        }
        deduped.push(chapter)
      }

      if (!deduped.length) return splitByLength(body)
      if (deduped[0].start > 0) deduped.unshift({ title: '开篇', start: 0 })

      // A heading followed by almost nothing is usually a false positive (a
      // table of contents, a stray subtitle). Dropping it lets the previous
      // chapter absorb those characters. The final chapter is always kept so a
      // short ending ("尾声") never loses its title.
      const kept = [deduped[0]]
      for (let i = 1; i < deduped.length; i += 1) {
        const current = deduped[i]
        const next = deduped[i + 1]
        if (next && next.start - current.start < MIN_CHAPTER_CHARS) continue
        kept.push(current)
      }
      return kept
    }

    /**
     * Body bounds for each chapter. The heading line is metadata — the reader
     * paints it as the page title — so the body starts after it. Files often
     * repeat that line (occasionally twice, or without the 第N章 prefix), and a
     * stored table may point at the second copy; both cases are normalised here
     * so a chapter never renders its own title twice nor the next one's at the
     * bottom.
     */
    function layoutChapters(text, chapters) {
      const body = typeof text === 'string' ? text : ''
      const list = Array.isArray(chapters) ? chapters : []
      const out = []

      const clamp = (value) => Math.min(Math.max(0, Number(value) || 0), body.length)
      const skipBlank = (at) => {
        let cursor = at
        while (cursor < body.length && (body[cursor] === ' ' || body[cursor] === '\t' || body[cursor] === '\u3000')) {
          cursor += 1
        }
        if (body[cursor] === '\n') return cursor + 1
        return at
      }

      for (const chapter of list) {
        const title = String(chapter?.title ?? '')
        let start = clamp(chapter?.start)

        // A duplicate heading right before `start` means the stored offset is
        // the second copy: pull the boundary back so the previous chapter stops
        // in front of the title instead of swallowing it.
        const copy = body.lastIndexOf(title, start - 1)
        if (copy > 0 && body[copy - 1] === '\n') {
          const gap = body.slice(copy + title.length, start)
          if (gap.length > 0 && gap.length <= DUPLICATE_HEADING_WINDOW && /^[ \t\u3000\n]*$/.test(gap) && gap.includes('\n')) {
            start = copy
          }
        }

        let from = skipBlank(start)
        const rest = titleRemainder(title)
        for (let guard = 0; guard < 8; guard += 1) {
          const nextBlank = skipBlank(from)
          if (nextBlank !== from) {
            from = nextBlank
            continue
          }
          const newline = body.indexOf('\n', from)
          const lineEnd = newline === -1 ? body.length : newline
          const line = body.slice(from, lineEnd).trim()
          if (line !== '' && (line === title || (rest !== '' && line === rest))) {
            from = lineEnd < body.length ? lineEnd + 1 : lineEnd
            continue
          }
          break
        }

        out.push({ title, start, bodyStart: Math.min(from, body.length) })
      }
      return out
    }

    /** `第1章 初见` → `初见`; empty when the title carries no such prefix. */
    function titleRemainder(title) {
      const match = /^第[0-9零一二三四五六七八九十百千万两〇]{1,8}[章节回卷篇部集][ \t\u3000]*(.+)$/.exec(title)
      const rest = match ? match[1].trim() : ''
      return rest.length >= 2 && rest !== title ? rest : ''
    }

    function splitByLength(body) {
      const chapters = []
      for (let start = 0; start < body.length; start += FALLBACK_BLOCK_CHARS) {
        chapters.push({ title: `第 ${chapters.length + 1} 节`, start })
      }
      return chapters.length ? chapters : [{ title: '全文', start: 0 }]
    }

    function formatCount(value) {
      const number = Number(value) || 0
      if (number >= 10000) return `${(number / 10000).toFixed(number >= 100000 ? 0 : 1)} 万`
      return String(number)
    }

    /**
     * Split a long table of contents into fixed blocks. Grouping by the first
     * character of the title is useless for novels (almost every heading starts
     * with 第), so chapters are bucketed by position instead: 1–100, 101–200…
     */
    function groupChapters(chapters, size = TOC_GROUP_SIZE) {
      const list = chapters ?? []
      const step = Math.max(1, Math.trunc(size) || TOC_GROUP_SIZE)
      const groups = []
      for (let start = 0; start < list.length; start += step) {
        const end = Math.min(list.length, start + step)
        const items = []
        for (let index = start; index < end; index += 1) {
          items.push({ index, title: String(list[index]?.title ?? '') })
        }
        groups.push({ label: `${start + 1}–${end}`, start, end, items })
      }
      return groups
    }

    /** Replace `{name}` placeholders in a dictionary string. */
    function fill(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        values[key] === undefined ? match : String(values[key]),
      )
    }

    /**
     * Copies the transcript's own typography onto the inline strip: the same
     * font, size, line height, colour, letter spacing, and the same text
     * column (width and left edge) as a real assistant paragraph. Picking the
     * numbers up from the live DOM beats hard-coding them — the shell's tokens
     * change between builds and between themes.
     *
     * Returns null whenever nothing usable is on screen, in which case the
     * strip keeps its neutral defaults.
     */
    function typographyFrom(doc, outer) {
      try {
        if (!doc || typeof doc.querySelectorAll !== 'function' || typeof getComputedStyle !== 'function') return null
        const markdown = Array.from(doc.querySelectorAll('[class*="_markdown_"]'))
          .filter((node) => {
            try {
              const box = node.getBoundingClientRect()
              return Boolean(box) && box.width > 0
            } catch {
              return false
            }
          })
          .pop()
        if (!markdown || typeof markdown.getBoundingClientRect !== 'function') return null
        const computed = getComputedStyle(markdown)
        const text = markdown.getBoundingClientRect()
        if (!text || !(text.width > 0)) return null
        let left = 0
        if (outer && typeof outer.getBoundingClientRect === 'function') {
          const box = outer.getBoundingClientRect()
          left = Math.max(0, Math.round(text.left - box.left))
        }
        return {
          fontSize: computed.fontSize,
          lineHeight: computed.lineHeight,
          fontFamily: computed.fontFamily,
          fontWeight: computed.fontWeight,
          color: computed.color,
          letterSpacing: computed.letterSpacing === 'normal' ? undefined : computed.letterSpacing,
          width: Math.round(text.width),
          marginLeft: left,
        }
      } catch {
        return null
      }
    }

    /* ----------------------------------------------------------------- API -- */

    function apiPath(suffix) {
      return new URL(`${API_BASE}/${suffix}`, document.baseURI).pathname
    }

    async function fetchJson(suffix, init) {
      const response = await fetch(apiPath(suffix), {
        ...init,
        headers: { accept: 'application/json', ...(init && init.headers) },
        credentials: 'same-origin',
        cache: 'no-store',
      })
      let body = null
      try {
        body = await response.json()
      } catch {
        body = null
      }
      return { status: response.status, ok: response.ok, body }
    }

    async function fetchText(suffix) {
      const response = await fetch(apiPath(suffix), { credentials: 'same-origin', cache: 'no-store' })
      const text = await response.text()
      if (!response.ok) {
        let message = `HTTP ${response.status}`
        try {
          const body = JSON.parse(text)
          if (body && typeof body.message === 'string') message = body.message
        } catch {
          /* plain text error body */
        }
        throw new Error(message)
      }
      return text
    }

    function errorText(result) {
      if (result && result.body && typeof result.body.message === 'string') return result.body.message
      return result ? `HTTP ${result.status}` : 'network error'
    }

    /* -------------------------------------------------------- inline strip -- */

    /**
     * State of the composer strip. It lives outside React because the toggle is
     * the sidebar icon (another slot and another renderer) while the strip is a
     * dock entry.
     *
     * `hidden` → nothing; `picker` → a short book list; `reading` → five lines
     * of prose for `selectedId`.
     */
    const inlineStrip = (() => {
      let mode = 'hidden'
      let selectedId = null
      const listeners = new Set()
      const announce = () => {
        for (const listener of [...listeners]) listener(mode)
      }
      const api = {
        mode: () => mode,
        selectedId: () => selectedId,
        setMode(next) {
          const value = next === 'reading' ? 'reading' : next === 'picker' ? 'picker' : 'hidden'
          if (value === mode) return
          mode = value
          announce()
        },
        isVisible: () => mode !== 'hidden',
        read(bookId) {
          selectedId = typeof bookId === 'string' && bookId ? bookId : null
          mode = 'reading'
          announce()
        },
        showPicker() {
          api.setMode('picker')
        },
        hide() {
          api.setMode('hidden')
        },
        /** The icon: closed → pick a book; open → close. */
        toggle() {
          api.setMode(mode === 'hidden' ? 'picker' : 'hidden')
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      }
      return api
    })()

    /** Assigned in `apply`; the toggle panel hands the centre back to the chat. */
    let navigateToPanel = () => {}

    /** Text fetched for the strip is kept for the page's lifetime. */
    const bookCache = new Map()

    /** The book the reader most likely wants: started ones first, then newest. */
    function pickCurrentBook(books) {
      if (!Array.isArray(books) || books.length === 0) return null
      const rank = (book) => {
        const progress = book?.progress ?? {}
        const started = Number(progress.percent) > 0 || Number(progress.chapterIndex) > 0 ? 1 : 0
        return [started, Number(book?.updatedAt ?? 0)]
      }
      return [...books].sort((a, b) => {
        const [startedA, updatedA] = rank(a)
        const [startedB, updatedB] = rank(b)
        return startedB - startedA || updatedB - updatedA
      })[0]
    }

    function clampIndex(index, length) {
      if (!Number.isFinite(index) || length <= 0) return 0
      return Math.min(Math.max(0, Math.trunc(index)), length - 1)
    }

    /**
     * Five anonymous lines of the current book, above the composer. It has no
     * chrome: no title, no buttons, no chapter label — only the prose, so it
     * reads like part of the transcript.
     */
    function InlineStrip(props) {
      const t = props.t ?? ((key) => key)
      const [loaded, setLoaded] = React.useState({ book: null, chapters: [], text: null, error: null })
      const [index, setIndex] = React.useState(0)
      const [offset, setOffset] = React.useState(0)
      const saveTimer = React.useRef(null)
      const latest = React.useRef({ book: null, chapters: [], text: null, index: 0, offset: 0 })
      /* Watch the strip's real height: if the host ever stretches the dock
         entry, this line lands in the renderer console and therefore in the
         host log, which is the only ground truth available without a browser. */
      const tall = React.useRef(null)
      /* Offset (in characters) to restore when the next chapter body renders. */
      const restoreRef = React.useRef(0)
      /* Typography borrowed from a live transcript paragraph. */
      const [typo, setTypo] = React.useState(null)
      React.useEffect(() => {
        const node = tall.current
        if (!node) return
        try {
          const height = Number(node.offsetHeight ?? 0)
          if (height > 200) {
            console.error(
              '[dsh-novels] inline strip is too tall:',
              height,
              'parent=',
              node.parentElement ? node.parentElement.className || node.parentElement.tagName : 'none',
            )
          }
        } catch {
          /* measuring is optional */
        }
      })

      React.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const wanted = props.bookId ?? inlineStrip.selectedId()
          if (!wanted) {
            setLoaded({ book: null, chapters: [], text: null, error: null })
            return
          }
          let entry = bookCache.get(wanted)
          if (!entry) {
            const meta = await fetchJson(`books/${wanted}`)
            if (cancelled) return
            if (!meta.ok || !meta.body?.ok) {
              setLoaded({ book: null, chapters: [], text: null, error: errorText(meta) })
              return
            }
            const text = await fetchText(`books/${wanted}/text`)
            if (cancelled) return
            entry = { book: meta.body.book ?? null, chapters: meta.body.chapters ?? [], text }
            bookCache.set(wanted, entry)
          }
          const progress = entry.book?.progress ?? {}
          setLoaded({ book: entry.book, chapters: entry.chapters, text: entry.text, error: null })
          setIndex(clampIndex(Number(progress.chapterIndex) || 0, entry.chapters.length))
          const resumeAt = Math.max(0, Math.trunc(Number(progress.offsetChars) || 0))
          restoreRef.current = resumeAt
          setOffset(resumeAt)
        }
        load().catch((error) => {
          if (!cancelled) setLoaded({ book: null, chapters: [], text: null, error: String(error) })
        })
        return () => {
          cancelled = true
        }
      }, [props.bookId])

      const laid = React.useMemo(
        () => layoutChapters(loaded.text ?? '', loaded.chapters),
        [loaded.text, loaded.chapters],
      )
      const current = laid[index] ?? null
      const bodyText = React.useMemo(() => {
        if (!current) return ''
        const next = laid[index + 1]
        const end = next ? next.start : (loaded.text ?? '').length
        return (loaded.text ?? '').slice(current.bodyStart, end).replace(/^\s+/, '')
      }, [laid, index, loaded.text])

      latest.current = { book: loaded.book, chapters: loaded.chapters, text: loaded.text, index, offset }

      const persist = React.useCallback((nextIndex, nextOffset, immediate) => {
        const now = latest.current
        if (!now.book || !now.text) return
        const write = () => {
          const chapterStart = now.chapters[nextIndex]?.start ?? 0
          const percent = Math.max(0, Math.min(1, (chapterStart + nextOffset) / Math.max(1, now.text.length)))
          /* Keep the cached copy in step, so hiding and reopening the strip
             resumes where the reader stopped instead of at the old position. */
          const cached = bookCache.get(now.book.id)
          if (cached && cached.book) {
            cached.book = {
              ...cached.book,
              progress: { chapterIndex: nextIndex, offsetChars: nextOffset, percent },
            }
          }
          fetchJson(`books/${now.book.id}/progress`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chapterIndex: nextIndex, offsetChars: nextOffset, percent }),
          }).catch(() => {})
        }
        if (saveTimer.current) clearTimeout(saveTimer.current)
        if (immediate) write()
        else saveTimer.current = setTimeout(write, 600)
      }, [])

      React.useEffect(
        () => () => {
          if (saveTimer.current) clearTimeout(saveTimer.current)
        },
        [],
      )

      const move = (delta) => {
        const node = tall.current
        if (!node || !bodyText) return
        const max = Math.max(0, Number(node.scrollHeight ?? 0) - Number(node.clientHeight ?? 0))
        const next = Math.max(0, Math.min(max, Number(node.scrollTop ?? 0) + delta))
        node.scrollTop = next
        syncOffset(node)
      }

      /** Turns the current scroll position back into a chapter-relative offset. */
      const syncOffset = (node) => {
        if (!node) return
        const max = Math.max(0, Number(node.scrollHeight ?? 0) - Number(node.clientHeight ?? 0))
        const fraction = max > 0 ? Math.max(0, Math.min(1, Number(node.scrollTop ?? 0) / max)) : 0
        const next = Math.round(fraction * bodyText.length)
        setOffset(next)
        persist(index, next, false)
      }

      const lineStep = (node) => {
        let line = INLINE_LINE_FALLBACK
        try {
          if (typeof getComputedStyle === 'function' && node) {
            const measured = Number.parseFloat(getComputedStyle(node).lineHeight)
            if (Number.isFinite(measured) && measured > 0) line = measured
          }
        } catch {
          /* fall back to the constant */
        }
        return Math.round(line * INLINE_SCROLL_LINES)
      }

      const pageStep = (node) => {
        const visible = Number(node?.clientHeight ?? 0)
        return Math.max(1, Math.round(visible - INLINE_LINE_FALLBACK))
      }

      const jump = (delta) => {
        if (laid.length === 0) return
        const next = clampIndex(index + delta, laid.length)
        if (next === index) return
        setIndex(next)
        setOffset(0)
        restoreRef.current = 0
        if (tall.current) tall.current.scrollTop = 0
        persist(next, 0, true)
      }

      const onKeyDown = (event) => {
        const name = event.key
        const node = tall.current
        if (name === 'ArrowDown' || name === 'j') {
          event.preventDefault()
          move(lineStep(node))
        } else if (name === 'ArrowUp' || name === 'k') {
          event.preventDefault()
          move(-lineStep(node))
        } else if (name === 'PageDown' || name === ' ') {
          event.preventDefault()
          move(pageStep(node))
        } else if (name === 'PageUp') {
          event.preventDefault()
          move(-pageStep(node))
        } else if (name === 'ArrowRight') {
          event.preventDefault()
          jump(1)
        } else if (name === 'ArrowLeft') {
          event.preventDefault()
          jump(-1)
        } else if (name === 'Escape') {
          event.preventDefault()
          inlineStrip.hide()
        }
      }

      /* Restore the saved position once the chapter's text is actually in the
         element, and after every chapter change. Deliberately keyed on the
         chapter, not on the offset, so scrolling never fights this effect. */
      React.useEffect(() => {
        const node = tall.current
        if (!node || !bodyText) return
        const max = Math.max(0, Number(node.scrollHeight ?? 0) - Number(node.clientHeight ?? 0))
        const wanted = restoreRef.current
        const fraction = wanted > 0 ? Math.max(0, Math.min(1, wanted / Math.max(1, bodyText.length))) : 0
        node.scrollTop = Math.round(max * fraction)
      }, [index, bodyText])

      const chapterText = bodyText.slice(0, INLINE_DOM_CHARS)

      /* Borrow the transcript's typography (font, size, line height, colour and
         the text column's left edge and width) as soon as something is on
         screen, and again whenever the window is resized. Hooks stay above the
         early return so the count never changes between renders. */
      React.useEffect(() => {
        const measure = () => {
          const next = typographyFrom(typeof document === 'undefined' ? null : document, tall.current)
          if (next) setTypo(next)
        }
        measure()
        let remove = null
        try {
          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('resize', measure)
            remove = () => window.removeEventListener('resize', measure)
          }
        } catch {
          remove = null
        }
        return remove ?? undefined
      }, [chapterText])

      if (!current) return null

      if (!chapterText) {
        return h(
          'div',
          { className: 'dnv-inline', style: INLINE_BOX_STYLE, ref: tall },
          h('div', { className: 'dnv-inlineText', style: INLINE_TEXT_STYLE }, loaded.error ?? t('inlineEmpty')),
        )
      }
      const textStyle = typo ? { ...INLINE_TEXT_STYLE, ...typo } : INLINE_TEXT_STYLE
      const paragraphs = chapterText
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
      return h(
        'div',
        {
          className: 'dnv-inline',
          style: INLINE_BOX_STYLE,
          ref: tall,
          tabIndex: 0,
          onKeyDown,
          onScroll: (event) => syncOffset(event.currentTarget),
          onDoubleClick: () => navigateToPanel(FULL_PANEL_KEY),
        },
        h(
          'div',
          { className: 'dnv-inlineText', style: textStyle, key: 'text' },
          paragraphs.length > 0
            ? paragraphs.map((line, position) =>
                h(
                  'p',
                  { key: `p${position}`, style: position === 0 ? INLINE_FIRST_PARAGRAPH_STYLE : INLINE_PARAGRAPH_STYLE },
                  line,
                ),
              )
            : chapterText,
        ),
        h(
          'button',
          {
            key: 'expand',
            type: 'button',
            className: 'dnv-inlineExpand',
            title: t('inlineOpen'),
            onClick: (event) => {
              event.stopPropagation()
              navigateToPanel(FULL_PANEL_KEY)
            },
          },
          '⤢',
        ),
      )
    }

    /**
     * The compact book list shown the first time the icon is clicked: short
     * rows, its own scroll area, never taller than a few lines.
     */
    function InlinePicker(props) {
      const t = props.t ?? ((key) => key)
      const [state, setState] = React.useState({ loading: true, books: [], error: null })

      React.useEffect(() => {
        let cancelled = false
        fetchJson('library')
          .then((result) => {
            if (cancelled) return
            if (!result.ok || !result.body?.ok) {
              setState({ loading: false, books: [], error: errorText(result) })
              return
            }
            setState({ loading: false, books: result.body.books ?? [], error: null })
          })
          .catch((error) => {
            if (!cancelled) setState({ loading: false, books: [], error: String(error) })
          })
        return () => {
          cancelled = true
        }
      }, [])

      const choose = (book) => {
        inlineStrip.read(book.id)
      }

      const onKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          inlineStrip.hide()
        }
      }

      const current = inlineStrip.selectedId()
      return h(
        'div',
        { className: 'dnv-pick', style: INLINE_PICK_STYLE, onKeyDown, tabIndex: 0 },
        state.loading ? h('div', { className: 'dnv-pickHint' }, t('loading')) : null,
        !state.loading && state.error ? h('div', { className: 'dnv-pickHint' }, state.error) : null,
        !state.loading && !state.error && state.books.length === 0
          ? h('div', { className: 'dnv-pickHint' }, t('inlineEmpty'))
          : null,
        state.books.map((book) =>
          h(
            'button',
            {
              key: book.id,
              type: 'button',
              className: `dnv-pickRow${book.id === current ? ' dnv-pickRow-on' : ''}`,
              onClick: () => choose(book),
            },
            h('span', { className: 'dnv-pickTitle' }, book.title),
            h(
              'span',
              { className: 'dnv-pickMeta' },
              Number(book.progress?.chapterIndex) > 0 || Number(book.progress?.percent) > 0
                ? fill(t('progressAt'), { chapter: Number(book.progress?.chapterIndex ?? 0) + 1 })
                : t('unread'),
            ),
          ),
        ),
      )
    }

    /** The dock entry: picker, or prose, or nothing. */
    function InlineDock(props) {
      const [mode, setMode] = React.useState(() => inlineStrip.mode())
      React.useEffect(() => inlineStrip.subscribe(setMode), [])
      if (mode === 'picker') return h(InlinePicker, { t: props.t })
      if (mode === 'reading') return h(InlineStrip, { t: props.t })
      return null
    }

    /**
     * What the sidebar button mounts, but only as a safety net: the icon itself
     * stops the click before the shell selects a panel. If the key is ever
     * selected anyway (keyboard activation), flip the strip and hand the centre
     * column straight back to the conversation.
     */
    function InlineToggle() {
      const done = React.useRef(false)
      React.useEffect(() => {
        if (done.current) return
        done.current = true
        inlineStrip.toggle()
        navigateToPanel(null)
      }, [])
      return null
    }

    /* ---------------------------------------------------------------- icons -- */

    /** Open-book glyph; inherits `currentColor` from the sidebar button. */
    function NovelsIcon({ size = 16, active = false }) {
      const strokeWidth = active ? 1.9 : 1.6
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false', display: 'block' },
        h('path', {
          d: 'M12 6.6C10.5 5.2 8.4 4.5 5.9 4.5H4.5v13.6h1.9c2.4 0 4.4.6 5.6 1.7',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', {
          d: 'M12 6.6c1.5-1.4 3.6-2.1 6.1-2.1h1.4v13.6h-1.9c-2.4 0-4.4.6-5.6 1.7',
          stroke: 'currentColor',
          strokeWidth,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M12 6.6v13.2', stroke: 'currentColor', strokeWidth, strokeLinecap: 'round' }),
      )
    }

    /* ----------------------------------------------------------------- CSS -- */

    const CSS = `
.dnv-root{height:100%;min-height:0;flex:1 1 auto;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dnv-head{display:flex;align-items:center;gap:10px;padding:14px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:28px}
.dnv-title{font-size:15px;font-weight:600;letter-spacing:.01em}
.dnv-sub{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dnv-grow{flex:1;min-width:0}
.dnv-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:4px 10px;font:inherit;font-size:12px;cursor:pointer;line-height:1.5;white-space:nowrap}
.dnv-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dnv-btn:disabled{opacity:.55;cursor:default}
.dnv-btn-ghost{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dnv-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnv-body{flex:1;min-height:0;overflow:auto;padding:18px 20px 28px}
.dnv-body-drop{outline:2px dashed var(--dsw-alias-border-l2);outline-offset:-10px;background:var(--dsw-alias-bg-layer-1)}
.dnv-empty{max-width:640px;margin:8vh auto 0;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:14px;padding:34px 28px;background:var(--dsw-alias-bg-layer-1)}
.dnv-emptyTitle{font-size:15px;font-weight:600;margin:0 0 8px}
.dnv-emptyHint{font-size:12.5px;line-height:1.75;color:var(--dsw-alias-label-secondary);margin:0 0 18px}
.dnv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;max-width:1180px}
.dnv-book{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:13px 14px;min-width:0}
.dnv-book:hover{border-color:var(--dsw-alias-border-l2)}
.dnv-bookTitle{font-size:13.5px;font-weight:600;line-height:1.45;margin:0;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dnv-meta{display:flex;flex-wrap:wrap;gap:6px 10px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.dnv-tag{border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:0 7px;line-height:1.7}
.dnv-bookFoot{display:flex;align-items:center;gap:8px;margin-top:auto}
.dnv-storage{display:flex;align-items:center;gap:8px;padding:8px 20px;border-bottom:1px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-height:30px}
.dnv-storageLabel{flex:none;color:var(--dsw-alias-label-tertiary)}
.dnv-storagePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsw-alias-font-mono,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-secondary);direction:rtl;text-align:left}
.dnv-storageBtn{flex:none}
.dnv-link{appearance:none;border:0;background:none;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;padding:2px 0;text-decoration:underline;text-underline-offset:3px}
.dnv-status{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);padding:6px 0}
.dnv-err{color:var(--dsw-alias-state-error-primary)}
.dnv-ok{color:var(--dsw-alias-state-success-primary)}
.dnv-reader{flex:1;min-height:0;display:flex;flex-direction:column}
.dnv-readerHead{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:30px}
.dnv-readerTitle{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dnv-readerSub{font-size:11.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dnv-readerBody{flex:1;min-height:0;overflow:auto;outline:none;padding:26px 20px 48px;scroll-behavior:auto;scrollbar-gutter:stable;overscroll-behavior:contain}
.dnv-page{max-width:var(--dnv-measure,720px);margin:0 auto}
.dnv-chapterTitle{font-size:1.28em;font-weight:400;margin:0 0 .9em;line-height:1.5}
.dnv-text{white-space:pre-wrap;word-break:break-word;margin:0;font-family:inherit;font-weight:400}
.dnv-readerFoot{display:flex;align-items:center;gap:8px;padding:10px 16px;border-top:1px solid var(--dsw-alias-border-l1)}
.dnv-footHint{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dnv-progressLine{flex:none;height:2px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dnv-progressLineFill{height:100%;background:var(--dsw-alias-label-tertiary)}
.dnv-toc{border-bottom:1px solid var(--dsw-alias-border-l1);max-height:38%;overflow:auto;padding:8px 12px;background:var(--dsw-alias-bg-layer-1)}
.dnv-tocItem{appearance:none;display:block;width:100%;text-align:left;border:0;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1.5;padding:5px 8px;border-radius:6px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dnv-tocItem:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnv-tocItem[data-active="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dnv-toolbar{display:flex;align-items:center;gap:4px}
.dnv-size{font-size:11.5px;color:var(--dsw-alias-label-tertiary);min-width:34px;text-align:center}
.dnv-bookTitleRow{display:flex;align-items:center;gap:6px;min-width:0}
.dnv-bookTitleRow .dnv-bookTitle{flex:1;min-width:0}
.dnv-renameBtn{flex:none;visibility:hidden}
.dnv-book:hover .dnv-renameBtn,.dnv-renameBtn:focus-visible{visibility:visible}
.dnv-input{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border-radius:6px;padding:3px 7px;font:inherit;font-size:12.5px;min-width:0;flex:1}
.dnv-input:focus{outline:1px solid var(--dsw-alias-border-l2);outline-offset:0}
.dnv-bookProgress{display:flex;align-items:center;gap:8px;min-width:0}
.dnv-progress{flex:1;height:3px;min-width:40px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.dnv-progressFill{height:100%;background:var(--dsw-alias-label-tertiary);border-radius:999px}
.dnv-progressLabel{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dnv-tocGrouped{display:flex;flex-direction:column;gap:2px}
.dnv-tocSection{display:flex;flex-direction:column;gap:1px}
.dnv-tocGroupHead{appearance:none;display:flex;width:100%;text-align:left;border:0;background:none;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11.5px;line-height:1.5;padding:5px 8px;border-radius:6px;cursor:pointer;letter-spacing:.02em}
.dnv-tocGroupHead:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnv-tocGroupHead[data-active="true"]{color:var(--dsw-alias-label-secondary)}
.dnv-tocSection .dnv-tocItem{padding-left:18px}
.dnv-iconHit{display:inline-flex;align-items:center;justify-content:center;cursor:pointer}
.dnv-inline{position:relative;max-height:8.4em;font:inherit;line-height:1.7;color:var(--dsw-alias-label-primary);cursor:text;outline:none;user-select:text;overflow-y:auto;overflow-x:hidden;scrollbar-width:none;overscroll-behavior:contain}
.dnv-inline::-webkit-scrollbar{width:0;height:0;display:none}
.dnv-inlineText{white-space:pre-wrap;word-break:break-word;font-family:inherit;font-weight:400}
.dnv-inlineExpand{position:absolute;top:0;right:4px;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1;padding:3px 4px;border-radius:4px;cursor:pointer;opacity:0}
.dnv-inline:hover .dnv-inlineExpand,.dnv-inlineExpand:focus-visible{opacity:.65}
.dnv-inline:focus{outline:none}
.dnv-pick{max-width:720px;max-height:190px;margin:0 auto;padding:4px 16px 6px;overflow-y:auto;display:flex;flex-direction:column;gap:1px;outline:none}
.dnv-pickRow{appearance:none;display:flex;align-items:baseline;gap:10px;width:100%;text-align:left;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:1.6;padding:4px 8px;border-radius:5px;cursor:pointer}
.dnv-pickRow:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dnv-pickRow-on{color:var(--dsw-alias-label-primary)}
.dnv-pickTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dnv-pickMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dnv-pickHint{font-size:12px;color:var(--dsw-alias-label-tertiary);padding:4px 8px}
@media (prefers-reduced-motion: reduce){
  .dnv-root *{transition:none !important;animation:none !important}
}
`

    const CSS_TAG = 'dsh-novels/panel.css'

    /**
     * Install the stylesheet once, in the document head.
     *
     * It used to be a <style> element rendered inside the shelf's own tree,
     * which meant every rule disappeared the moment the shelf unmounted for the
     * reader: no flex column, no bounded height, no overflow, no scrolling.
     * Keeping it in the head makes it independent of whichever view is mounted.
     */
    function ensureStyles() {
      if (typeof document === 'undefined' || typeof document.createElement !== 'function') return false
      const head = document.head
      if (!head || typeof head.appendChild !== 'function') return false
      const selector = `style[data-plugin-css="${CSS_TAG}"]`
      if (typeof document.querySelector === 'function') {
        const existing = document.querySelector(selector)
        if (existing) {
          /* A style tag left over from an older bundle would otherwise keep
             the sheet's first version forever: every later rule would be
             silently missing. Rewrite it whenever the text differs. */
          if (existing.textContent !== CSS) existing.textContent = CSS
          return true
        }
      }
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG)
      tag.textContent = CSS
      head.appendChild(tag)
      return true
    }

    /* --------------------------------------------------------------- shelf -- */

    function BookCard({ book, t, onOpen, onDelete, onRename, onReveal, busy }) {
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const progress = book.progress ?? null
      const percent = progress && Number(progress.percent) > 0 ? Math.min(100, Math.round(progress.percent * 100)) : 0
      const chapterNumber = progress ? Math.trunc(Number(progress.chapterIndex) || 0) + 1 : 0
      const started = percent > 0 || chapterNumber > 1

      const commitRename = () => {
        const next = draft.trim()
        setEditing(false)
        if (!next || next === (book.title ?? '')) return
        onRename(book, next)
      }

      return h(
        'article',
        { className: 'dnv-book' },
        editing
          ? h(
              'div',
              { className: 'dnv-bookTitleRow' },
              h('input', {
                className: 'dnv-input',
                value: draft,
                placeholder: t('renamePlaceholder'),
                onChange: (event) => setDraft(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    commitRename()
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    if (typeof event.stopPropagation === 'function') event.stopPropagation()
                    setEditing(false)
                  }
                },
              }),
              h('button', { type: 'button', className: 'dnv-btn', onClick: commitRename }, t('renameSave')),
              h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: () => setEditing(false) }, t('renameCancel')),
            )
          : h(
              'div',
              { className: 'dnv-bookTitleRow' },
              h('h3', { className: 'dnv-bookTitle', title: book.title }, book.title || '未命名'),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dnv-btn dnv-btn-ghost dnv-renameBtn',
                  disabled: busy,
                  onClick: () => {
                    setDraft(book.title ?? '')
                    setEditing(true)
                  },
                },
                t('rename'),
              ),
            ),
        h(
          'div',
          { className: 'dnv-meta' },
          h('span', null, `${formatCount(book.chapters ?? book.chapterCount)} ${t('chapters')}`),
          h('span', null, `${formatCount(book.chars)} ${t('chars')}`),
          book.encoding ? h('span', { className: 'dnv-tag' }, book.encoding) : null,
          percent > 0 ? h('span', { className: 'dnv-tag' }, `${percent}%`) : null,
        ),
        h(
          'div',
          { className: 'dnv-bookProgress' },
          h(
            'div',
            { className: 'dnv-progress' },
            h('div', { className: 'dnv-progressFill', style: { width: `${percent}%` } }),
          ),
          h(
            'span',
            { className: 'dnv-progressLabel' },
            started ? fill(t('progressAt'), { chapter: chapterNumber }) : t('unread'),
          ),
        ),
        h(
          'div',
          { className: 'dnv-bookFoot' },
          h('button', { type: 'button', className: 'dnv-link', onClick: () => onOpen(book) }, t('open')),
          h('span', { className: 'dnv-grow' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dnv-btn dnv-btn-ghost dnv-revealBtn',
              title: book.filePath ? `${t('revealHint')}: ${book.filePath}` : t('revealHint'),
              disabled: busy,
              onClick: () => onReveal(book),
            },
            t('reveal'),
          ),
          h(
            'button',
            { type: 'button', className: 'dnv-btn dnv-btn-ghost', disabled: busy, onClick: () => onDelete(book) },
            t('remove'),
          ),
        ),
      )
    }

    function Shelf({ t, state, onUpload, onOpen, onDelete, onRename, onReveal, onRevealDir, onRefresh, busyBookId }) {
      const [dragDepth, setDragDepth] = React.useState(0)
      const inputRef = React.useRef(null)

      const pick = () => inputRef.current?.click()
      const onPicked = (event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) onUpload(file)
      }

      const dropHandlers = {
        onDragEnter: (event) => {
          event.preventDefault()
          setDragDepth((depth) => depth + 1)
        },
        onDragOver: (event) => {
          event.preventDefault()
        },
        onDragLeave: (event) => {
          event.preventDefault()
          setDragDepth((depth) => Math.max(0, depth - 1))
        },
        onDrop: (event) => {
          event.preventDefault()
          setDragDepth(0)
          const file = event.dataTransfer?.files?.[0]
          if (file) onUpload(file)
        },
      }

      const books = state.books ?? []
      const dropping = dragDepth > 0

      return h(
        'div',
        { className: 'dnv-root' },
        h(
          'header',
          { className: 'dnv-head' },
          h('span', { className: 'dnv-title' }, t('panelTitle')),
          h('span', { className: 'dnv-sub' }, `${books.length} ${t('books')}`),
          h('span', { className: 'dnv-grow' }),
          state.busy === 'upload'
            ? h(
                'span',
                { className: 'dnv-status' },
                state.uploadPercent === null || state.uploadPercent === undefined
                  ? t('uploading')
                  : fill(t('uploadingPercent'), { percent: state.uploadPercent }),
              )
            : h('button', { type: 'button', className: 'dnv-btn', onClick: pick }, t('upload')),
          h('input', {
            key: 'file',
            ref: inputRef,
            type: 'file',
            accept: '.txt,text/plain',
            style: { display: 'none' },
            onChange: onPicked,
          }),
        ),
        h(
          'div',
          { className: 'dnv-storage' },
          h('span', { className: 'dnv-storageLabel' }, t('storageAt')),
          h('code', { className: 'dnv-storagePath', title: state.dataDir ?? '' }, state.dataDir ?? '—'),
          h(
            'button',
            {
              type: 'button',
              className: 'dnv-btn dnv-btn-ghost dnv-storageBtn',
              title: t('storageHint'),
              onClick: onRevealDir,
            },
            t('revealDir'),
          ),
        ),
        h(
          'div',
          { className: `dnv-body${dropping ? ' dnv-body-drop' : ''}`, ...dropHandlers },
          state.error
            ? h(
                'div',
                { className: 'dnv-status dnv-err' },
                `${t('importFailed')}: ${state.error} `,
                h('button', { type: 'button', className: 'dnv-link', onClick: onRefresh }, t('retry')),
              )
            : null,
          dropping ? h('div', { className: 'dnv-status dnv-ok' }, t('dropHere')) : null,
          state.loading && !books.length
            ? h('div', { className: 'dnv-status' }, t('loading'))
            : !books.length
              ? h(
                  'div',
                  { className: 'dnv-empty' },
                  h('p', { className: 'dnv-emptyTitle' }, t('empty')),
                  h('p', { className: 'dnv-emptyHint' }, t('emptyHint')),
                  h('button', { type: 'button', className: 'dnv-btn', onClick: pick }, t('upload')),
                )
              : h(
                  'div',
                  { className: 'dnv-grid' },
                  books.map((book) =>
                    h(BookCard, {
                      key: book.id,
                      book,
                      t,
                      busy: busyBookId === book.id,
                      onOpen,
                      onDelete,
                      onRename,
                      onReveal,
                    }),
                  ),
                ),
          state.notice ? h('div', { className: 'dnv-status dnv-ok' }, state.notice) : null,
        ),
      )
    }

    /* -------------------------------------------------------------- reader -- */

    function Reader({ t, book, chapters, text, loading, error, prefs, onBack, onRetry, onProgress, onPrefsChange }) {
      // Do not clamp against `chapters` here: the panel mounts the reader before
      // its fetches resolve, so the table is still empty on the first render.
      const initial = Math.max(0, book?.progress?.chapterIndex ?? 0)
      const [index, setIndex] = React.useState(initial)
      const [tocOpen, setTocOpen] = React.useState(false)
      const [fontSize, setFontSize] = React.useState(prefs?.fontSize ?? 18)
      const [lineHeight, setLineHeight] = React.useState(prefs?.lineHeight ?? 1.9)
      const [measure, setMeasure] = React.useState(Math.min(MAX_MEASURE, Math.max(MIN_MEASURE, prefs?.measure ?? 720)))
      /** Fraction of the whole book read so far, for the strip under the footer. */
      const [readPercent, setReadPercent] = React.useState(0)
      const bodyRef = React.useRef(null)
      const rootRef = React.useRef(null)
      const restoredRef = React.useRef(false)
      const previousIndex = React.useRef(initial)
      const savedPrefs = React.useRef({
        fontSize: prefs?.fontSize ?? 18,
        lineHeight: prefs?.lineHeight ?? 1.9,
        measure: prefs?.measure ?? 720,
      })
      const progressTimer = React.useRef(null)
      const latest = React.useRef({ index: initial, fraction: 0 })
      /** `{chapter, fraction}` waiting for its chapter body to be rendered. */
      const pendingRestore = React.useRef(null)

      const rangeOf = (chapter) => {
        const start = chapters[chapter]?.start ?? 0
        const end = chapter + 1 < chapters.length ? chapters[chapter + 1].start : typeof text === 'string' ? text.length : start
        return [start, Math.max(start + 1, end)]
      }

      // Reading position travels as (chapter, fraction inside it): the fraction
      // survives different font sizes, the offsetChars field is only for display.
      const emitProgress = (chapter, fraction) => {
        if (typeof onProgress !== 'function') return
        const clamped = Math.min(Math.max(fraction, 0), 1)
        latest.current = { index: chapter, fraction: clamped }
        const [start, end] = rangeOf(chapter)
        const offsetChars = Math.round(start + clamped * (end - start))
        const percent = chapters.length ? Math.min(1, (chapter + clamped) / chapters.length) : 0
        onProgress({ chapterIndex: chapter, offsetChars, percent })
      }

      const currentFraction = () => {
        const node = bodyRef.current
        if (!node) return 0
        const span = node.scrollHeight - node.clientHeight
        return span > 0 ? Math.min(1, Math.max(0, node.scrollTop / span)) : 0
      }

      const flushProgress = () => {
        const fraction = currentFraction()
        if (chapters.length > 0) {
          setReadPercent(Math.min(1, (latest.current.index + fraction) / chapters.length))
        }
        emitProgress(latest.current.index, fraction)
      }

      // A saved position is restored once, but only when both the chapter table
      // and the body are here. Applying it earlier would clamp the chapter to
      // the empty table (i.e. to the first chapter) and leave it there.
      React.useEffect(() => {
        if (restoredRef.current) return
        if (!chapters.length || typeof text !== 'string') return
        restoredRef.current = true
        const saved = book?.progress ?? {}
        const chapter = Math.min(Math.max(saved.chapterIndex ?? 0, 0), chapters.length - 1)
        const [start, end] = rangeOf(chapter)
        const offset = Math.min(Math.max(saved.offsetChars ?? start, start), end)
        const fraction = Math.min(1, Math.max(0, (offset - start) / Math.max(1, end - start)))
        pendingRestore.current = { chapter, fraction }
        latest.current = { index: chapter, fraction }
        setIndex(chapter)
      }, [text, chapters, book])

      // Only an actual chapter change jumps back to the top; a restore already
      // knows where it wants to be, so it must not be reported as a turn.
      React.useEffect(() => {
        if (previousIndex.current === index) return
        previousIndex.current = index
        if (pendingRestore.current !== null) return
        restoredRef.current = true
        if (bodyRef.current) bodyRef.current.scrollTop = 0
        latest.current = { index, fraction: 0 }
        if (chapters.length > 0) setReadPercent(Math.min(1, index / chapters.length))
        emitProgress(index, 0)
      }, [index])

      // Reader prefs persist per profile, not per book.
      React.useEffect(() => {
        const previous = savedPrefs.current
        if (previous.fontSize === fontSize && previous.lineHeight === lineHeight && previous.measure === measure) return
        savedPrefs.current = { fontSize, lineHeight, measure }
        if (typeof onPrefsChange === 'function') onPrefsChange({ fontSize, lineHeight, measure })
      }, [fontSize, lineHeight, measure])

      React.useEffect(
        () => () => {
          if (progressTimer.current) clearTimeout(progressTimer.current)
          flushProgress()
        },
        [],
      )

      const onScroll = () => {
        if (progressTimer.current) clearTimeout(progressTimer.current)
        progressTimer.current = setTimeout(() => {
          progressTimer.current = null
          flushProgress()
        }, 700)
      }

      const total = chapters.length
      // Heading lines are painted as the page title, so the body starts after
      // them (and after any repeated copy of one). Stored tables from older
      // versions only carry `start`; both shapes go through this.
      const laid = React.useMemo(() => layoutChapters(text, chapters), [text, chapters])
      const current = laid[index] ?? { title: '', start: 0, bodyStart: 0 }
      const chapterText = React.useMemo(() => {
        if (typeof text !== 'string') return ''
        const start = Math.max(0, current.bodyStart ?? current.start ?? 0)
        const end = index + 1 < total ? Math.max(start, laid[index + 1].start) : text.length
        return text.slice(start, end).replace(/\s+$/, '')
      }, [text, laid, index, total, current.bodyStart, current.start])

      // The restore above only picks the chapter; the scroll offset can be set
      // once that chapter's body is actually in the DOM (a remount scrolls to
      // the top on its own, and a frame may be needed for the layout to settle).
      React.useEffect(() => {
        const pending = pendingRestore.current
        if (pending === null || pending.chapter !== index) return
        const node = bodyRef.current
        if (!node) return
        pendingRestore.current = null
        const apply = () => {
          const span = Math.max(0, node.scrollHeight - node.clientHeight)
          node.scrollTop = Math.round(pending.fraction * span)
        }
        apply()
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(apply)
        }
      }, [index, text, chapters])

      const go = React.useCallback(
        (delta) => {
          setIndex((value) => Math.min(Math.max(value + delta, 0), total - 1))
        },
        [total],
      )

      const scrollPage = (direction) => {
        const node = bodyRef.current
        if (!node) return
        node.scrollTop += direction * Math.max(120, node.clientHeight * 0.86)
      }

      const onKeyDown = (event) => {
        const meta = event.ctrlKey || event.metaKey
        if (meta && (event.key === '=' || event.key === '+')) {
          event.preventDefault()
          setFontSize((size) => Math.min(34, size + 1))
          return
        }
        if (meta && event.key === '-') {
          event.preventDefault()
          setFontSize((size) => Math.max(12, size - 1))
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          onBack()
          return
        }
        if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
          event.preventDefault()
          go(-1)
          return
        }
        if (event.key === 'ArrowRight' || event.key === 'PageDown') {
          event.preventDefault()
          go(1)
          return
        }
        if (event.key === 'j' || event.key === 'k') {
          event.preventDefault()
          scrollPage(event.key === 'j' ? 1 : -1)
          return
        }
        if (event.key === ' ') {
          event.preventDefault()
          scrollPage(1)
        }
      }

      // The stylesheet sizes the panel as a bounded flex column, so normally
      // nothing here has to run. If a host layout ever hands this slot an
      // auto-height box the percentage height collapses to the content height
      // and the body stops scrolling; only in that case pin a measured pixel
      // height, so the footer cannot be pushed out of the visible panel.
      const layoutEffect = React.useLayoutEffect ?? React.useEffect
      const fittedRef = React.useRef(-1)
      layoutEffect(() => {
        const node = rootRef.current
        if (!node || typeof window === 'undefined' || typeof node.getBoundingClientRect !== 'function') return undefined

        const clippingAncestor = () => {
          let el = node.parentElement
          while (el !== null && el !== document.documentElement) {
            const style = typeof window.getComputedStyle === 'function' ? window.getComputedStyle(el) : null
            const clips =
              style !== null &&
              (style.overflowY === 'hidden' || style.overflowY === 'auto' || style.overflowY === 'scroll')
            if (clips && el.clientHeight > 0) return el
            el = el.parentElement
          }
          return null
        }

        const fit = (force = false) => {
          // Already bounded by the stylesheet (or pinned by an earlier pass).
          if (!force && node.style.height !== '') return
          if (!force && node.getBoundingClientRect().height >= MIN_READER_HEIGHT) return
          const own = node.getBoundingClientRect()
          const box = clippingAncestor()
          const bottom = box === null ? window.innerHeight : box.getBoundingClientRect().bottom
          const height = fittedReaderHeight(own.top, bottom, window.innerHeight)
          fittedRef.current = height
          node.style.height = `${height}px`
        }

        fit()

        // Self-heal: if the sheet is missing (stripped from head, blocked by a
        // policy, or a future refactor drops it) the reader would lose its
        // bounded column again. Detect it once per mount and apply the minimum
        // inline, then pin a measured height.
        try {
          const body = bodyRef.current
          if (body !== null && body !== undefined && typeof window.getComputedStyle === 'function') {
            if (window.getComputedStyle(body).overflowY !== 'auto') {
              ensureStyles()
              node.style.display = 'flex'
              node.style.flexDirection = 'column'
              node.style.minHeight = '0'
              body.style.flex = '1 1 auto'
              body.style.minHeight = '0'
              body.style.overflowY = 'auto'
              fit(true)
            }
          }
        } catch {
          /* the stylesheet path is primary; the fallback must never throw */
        }

        let observer = null
        if (typeof window.ResizeObserver === 'function') {
          observer = new window.ResizeObserver(() => fit())
          observer.observe(document.body)
        }
        window.addEventListener('resize', fit)
        return () => {
          if (observer !== null) observer.disconnect()
          window.removeEventListener('resize', fit)
        }
      }, [])

      const pageStyle = {
        fontSize: `${fontSize}px`,
        lineHeight: String(lineHeight),
        '--dnv-measure': `${measure}px`,
      }

      // Long novels get a bucketed table of contents: only the bucket that
      // holds the current chapter is expanded, so a thousands-of-chapters book
      // still renders quickly.
      const tocGroups = total > TOC_GROUP_THRESHOLD ? groupChapters(chapters) : null
      const activeGroupLabel =
        tocGroups === null
          ? null
          : (tocGroups.find((group) => group.items.some((item) => item.index === index))?.label ??
            tocGroups[0]?.label ??
            null)
      const [openGroup, setOpenGroup] = React.useState(null)
      const shownGroup = openGroup === null ? activeGroupLabel : openGroup === '' ? null : openGroup

      return h(
        'div',
        { className: 'dnv-root dnv-reader', onKeyDown, tabIndex: -1, ref: rootRef },
        h(
          'header',
          { className: 'dnv-readerHead' },
          h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: onBack }, `← ${t('back')}`),
          h('span', { className: 'dnv-readerTitle', title: book?.title }, book?.title ?? ''),
          h('span', { className: 'dnv-readerSub' }, `${index + 1}/${total || 1}`),
          h('span', { className: 'dnv-grow' }),
          h(
            'div',
            { className: 'dnv-toolbar' },
            h('span', { className: 'dnv-size' }, 'A'),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: () => setFontSize((s) => Math.max(12, s - 1)) }, '−'),
            h('span', { className: 'dnv-size' }, `${fontSize}`),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: () => setFontSize((s) => Math.min(34, s + 1)) }, '+'),
          ),
          h(
            'div',
            { className: 'dnv-toolbar' },
            h('span', { className: 'dnv-size' }, '↕'),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: () => setLineHeight((v) => Math.max(1.2, Number((v - 0.1).toFixed(1)))) }, '−'),
            h('span', { className: 'dnv-size' }, lineHeight.toFixed(1)),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost', onClick: () => setLineHeight((v) => Math.min(2.6, Number((v + 0.1).toFixed(1)))) }, '+'),
          ),
          h(
            'div',
            { className: 'dnv-toolbar', title: t('measure') },
            h('span', { className: 'dnv-size' }, '↔'),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost dnv-measureBtn', 'data-step': '-1', onClick: () => setMeasure((v) => Math.max(MIN_MEASURE, v - MEASURE_STEP)) }, '−'),
            h('span', { className: 'dnv-size dnv-measureValue' }, `${measure}`),
            h('button', { type: 'button', className: 'dnv-btn dnv-btn-ghost dnv-measureBtn', 'data-step': '1', onClick: () => setMeasure((v) => Math.min(MAX_MEASURE, v + MEASURE_STEP)) }, '+'),
          ),
          h('button', { type: 'button', className: 'dnv-btn', onClick: () => setTocOpen((open) => !open) }, tocOpen ? t('closeToc') : t('toc')),
        ),
        tocOpen
          ? tocGroups === null
            ? h(
                'nav',
                { className: 'dnv-toc' },
                chapters.map((chapter, i) =>
                  h(
                    'button',
                    {
                      key: `${i}-${chapter.start}`,
                      type: 'button',
                      className: 'dnv-tocItem',
                      'data-active': i === index ? 'true' : 'false',
                      onClick: () => {
                        setIndex(i)
                        setTocOpen(false)
                      },
                    },
                    chapter.title,
                  ),
                ),
              )
            : h(
                'nav',
                { className: 'dnv-toc dnv-tocGrouped' },
                tocGroups.map((group) =>
                  h(
                    'div',
                    { className: 'dnv-tocSection', key: group.label },
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dnv-tocGroupHead',
                        'data-active': group.label === activeGroupLabel ? 'true' : 'false',
                        'data-group': group.label,
                        onClick: () => setOpenGroup((open) => (open === group.label ? '' : group.label)),
                      },
                      `${group.label} · ${fill(t('tocGroup'), { count: group.items.length })}`,
                    ),
                    group.label === shownGroup
                      ? group.items.map((item) =>
                          h(
                            'button',
                            {
                              key: `${item.index}`,
                              type: 'button',
                              className: 'dnv-tocItem',
                              'data-active': item.index === index ? 'true' : 'false',
                              onClick: () => {
                                setIndex(item.index)
                                setTocOpen(false)
                              },
                            },
                            item.title,
                          ),
                        )
                      : null,
                  ),
                ),
              )
          : null,
        h(
          'div',
          { className: 'dnv-readerBody', ref: bodyRef, tabIndex: 0, onScroll },
          loading
            ? h('div', { className: 'dnv-status' }, t('loading'))
            : error
              ? h(
                  'div',
                  { className: 'dnv-status dnv-err' },
                  `${t('loadFailed')}: ${error} `,
                  h('button', { type: 'button', className: 'dnv-link', onClick: onRetry }, t('retry')),
                )
              : h(
                  'div',
                  { className: 'dnv-page', style: pageStyle },
                  h('h2', { className: 'dnv-chapterTitle' }, current.title),
                  h('div', { className: 'dnv-text' }, chapterText),
                ),
        ),
        h(
          'footer',
          { className: 'dnv-readerFoot' },
          h('button', { type: 'button', className: 'dnv-btn', disabled: index <= 0, onClick: () => go(-1), title: t('firstChapter') }, `← ${t('prev')}`),
          h('button', { type: 'button', className: 'dnv-btn', disabled: index >= total - 1, onClick: () => go(1), title: t('lastChapter') }, `${t('next')} →`),
          h('span', { className: 'dnv-footHint' }, t('readerHint')),
        ),
        // Thin book-level progress strip pinned to the bottom edge.
        h(
          'div',
          { className: 'dnv-progressLine' },
          h('div', { className: 'dnv-progressLineFill', style: { width: `${Math.round(readPercent * 100)}%` } }),
        ),
      )
    }

    /* --------------------------------------------------------------- panel -- */

    function NovelsPanel(props) {
      const t = props.t ?? ((key) => key)
      const [library, setLibrary] = React.useState({ loading: true, books: [], prefs: null, error: null, notice: null })
      const [view, setView] = React.useState({ name: 'shelf' })
      const [reader, setReader] = React.useState({ loading: false, text: null, chapters: [], error: null })
      const [busyBookId, setBusyBookId] = React.useState(null)
      /** Progress writes still in flight, so a reopen never reads older data. */
      const pendingSaves = React.useRef(new Set())

      const loadLibrary = React.useCallback(async (notice) => {
        setLibrary((state) => ({ ...state, loading: true }))
        const result = await fetchJson('library')
        if (result.ok && result.body?.ok) {
          setLibrary({
            loading: false,
            books: result.body.books ?? [],
            prefs: result.body.prefs ?? null,
            dataDir: result.body.dataDir ?? null,
            error: null,
            notice: notice ?? null,
          })
        } else {
          setLibrary((state) => ({ ...state, loading: false, error: errorText(result) }))
        }
      }, [])

      React.useEffect(() => {
        loadLibrary()
      }, [loadLibrary])

      const openBook = React.useCallback(async (book) => {
        setView({ name: 'reader', book })
        setReader({ loading: true, text: null, chapters: [], error: null })
        try {
          // Let in-flight progress writes land first: the metadata read below
          // must not be older than the page the user just left.
          const saves = [...pendingSaves.current]
          if (saves.length > 0) await Promise.allSettled(saves)
          const meta = await fetchJson(`books/${book.id}`)
          if (!meta.ok || !meta.body?.ok) throw new Error(errorText(meta))
          const chapters = meta.body.chapters ?? []
          const fresh = meta.body.book ?? book
          const text = await fetchText(`books/${book.id}/text`)
          setView((state) =>
            state.name === 'reader' && state.book?.id === book.id ? { ...state, book: fresh } : state,
          )
          setReader({ loading: false, text, chapters, error: null })
        } catch (error) {
          setReader({ loading: false, text: null, chapters: [], error: error instanceof Error ? error.message : String(error) })
        }
      }, [])

      const uploadFile = React.useCallback(
        async (file) => {
          const name = file?.name ?? ''
          if (!/\.txt$/i.test(name)) {
            setLibrary((state) => ({ ...state, error: t('notText') }))
            return
          }
          if (file.size > MAX_UPLOAD_BYTES) {
            setLibrary((state) => ({ ...state, error: t('tooLarge') }))
            return
          }
          setLibrary((state) => ({ ...state, busy: 'upload', uploadPercent: 0, error: null, notice: null }))
          try {
            // Read the file in slices so the header can show real progress and
            // a 20 MB book does not allocate twice its size in one go.
            const bytes = new Uint8Array(file.size)
            let offset = 0
            while (offset < file.size) {
              const slice = file.slice(offset, Math.min(file.size, offset + UPLOAD_CHUNK_BYTES))
              const chunk = new Uint8Array(await slice.arrayBuffer())
              bytes.set(chunk, offset)
              offset += chunk.length
              const percent = file.size === 0 ? 100 : Math.min(100, Math.round((offset / file.size) * 100))
              setLibrary((state) => ({ ...state, uploadPercent: percent }))
            }
            if (file.size === 0) throw new Error(t('emptyFile'))
            const { text, encoding } = decodeBytes(bytes)
            const normalized = normalizeText(text)
            if (!normalized.trim()) throw new Error(t('emptyFile'))
            const chapters = splitChapters(normalized)
            const result = await fetchJson('books', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, text: normalized, encoding, chapters }),
            })
            if (!result.ok || !result.body?.ok) throw new Error(errorText(result))
            await loadLibrary(`${name} · ${encoding} · ${chapters.length} ${t('chapters')}`)
            setLibrary((state) => ({ ...state, busy: null, uploadPercent: null }))
          } catch (error) {
            setLibrary((state) => ({
              ...state,
              busy: null,
              uploadPercent: null,
              error: error instanceof Error ? error.message : String(error),
            }))
          }
        },
        [loadLibrary, t],
      )

      const renameBook = React.useCallback(
        async (book, title) => {
          const next = String(title ?? '').trim()
          if (!next || next === book.title) return
          setBusyBookId(book.id)
          try {
            const result = await fetchJson(`books/${book.id}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ title: next }),
            })
            if (!result.ok || !result.body?.ok) throw new Error(errorText(result))
            const saved = result.body.book?.title ?? next
            setLibrary((state) => ({
              ...state,
              books: state.books.map((item) => (item.id === book.id ? { ...item, title: saved } : item)),
            }))
            setView((state) =>
              state.name === 'reader' && state.book?.id === book.id ? { ...state, book: { ...state.book, title: saved } } : state,
            )
          } catch (error) {
            setLibrary((state) => ({ ...state, error: error instanceof Error ? error.message : String(error) }))
          } finally {
            setBusyBookId(null)
          }
        },
        [],
      )

      const deleteBook = React.useCallback(
        async (book) => {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            const ok = window.confirm(t('deleteConfirm').replace('{title}', book.title ?? ''))
            if (!ok) return
          }
          setBusyBookId(book.id)
          try {
            const result = await fetchJson(`books/${book.id}`, { method: 'DELETE' })
            if (!result.ok || !result.body?.ok) throw new Error(errorText(result))
            await loadLibrary()
          } catch (error) {
            setLibrary((state) => ({ ...state, error: error instanceof Error ? error.message : String(error) }))
          } finally {
            setBusyBookId(null)
          }
        },
        [loadLibrary, t],
      )

      const saveProgress = React.useCallback(async (bookId, progress) => {
        const task = (async () => {
          try {
            const result = await fetchJson(`books/${bookId}/progress`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(progress),
            })
            if (!result.ok || !result.body?.ok) return
            setLibrary((state) => ({
              ...state,
              books: state.books.map((item) =>
                item.id === bookId ? { ...item, progress: result.body.progress } : item,
              ),
            }))
            setView((state) =>
              state.name === 'reader' && state.book?.id === bookId
                ? { ...state, book: { ...state.book, progress: result.body.progress } }
                : state,
            )
          } catch {
            /* reading position is best effort; never interrupt the reader */
          }
        })()
        pendingSaves.current.add(task)
        task.finally(() => pendingSaves.current.delete(task))
        return task
      }, [])

      /**
       * Ask the Host to reveal a file in the OS file manager. The browser cannot
       * do this itself, and the Host derives the path from the book id, so the
       * client never sends a path.
       */
      const revealBook = React.useCallback(
        async (book) => {
          try {
            const result = await fetchJson(`books/${book.id}/reveal`, { method: 'POST' })
            if (!result.ok || !result.body?.ok) throw new Error(result.body?.message ?? t('revealFailed'))
          } catch (error) {
            setLibrary((state) => ({ ...state, error: error instanceof Error ? error.message : t('revealFailed') }))
          }
        },
        [t],
      )

      const revealStorage = React.useCallback(async () => {
        try {
          const result = await fetchJson('reveal', { method: 'POST' })
          if (!result.ok || !result.body?.ok) throw new Error(result.body?.message ?? t('revealFailed'))
        } catch (error) {
          setLibrary((state) => ({ ...state, error: error instanceof Error ? error.message : t('revealFailed') }))
        }
      }, [t])

      const changePrefs = React.useCallback(async (patch) => {        setLibrary((state) => ({ ...state, prefs: { ...(state.prefs ?? {}), ...patch } }))
        try {
          const result = await fetchJson('prefs', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          })
          if (result.ok && result.body?.ok) setLibrary((state) => ({ ...state, prefs: result.body.prefs }))
        } catch {
          /* the local value already applies; persistence can retry next change */
        }
      }, [])

      if (view.name === 'reader') {
        return h(Reader, {
          t,
          book: view.book,
          chapters: reader.chapters,
          text: reader.text,
          loading: reader.loading,
          error: reader.error,
          prefs: library.prefs,
          onProgress: (progress) => saveProgress(view.book.id, progress),
          onPrefsChange: changePrefs,
          onBack: () => {
            setView({ name: 'shelf' })
            setReader({ loading: false, text: null, chapters: [], error: null })
            loadLibrary()
          },
          onRetry: () => openBook(view.book),
        })
      }

      return h(Shelf, {
        t,
        state: { ...library, ...(library.notice ? { notice: library.notice } : {}) },
        onUpload: uploadFile,
        onOpen: openBook,
        onDelete: deleteBook,
        onRename: renameBook,
        onReveal: revealBook,
        onRevealDir: revealStorage,
        onRefresh: () => loadLibrary(),
        busyBookId,
      })
    }

    return {
      name: 'dsh-novels',
      inject: ['slots', 'locale'],
      /** Node-side tests reach the pure text pipeline through this. */
      testHooks: {
        decodeBytes,
        normalizeText,
        splitChapters,
        layoutChapters,
        groupChapters,
        fittedReaderHeight,
        typographyFrom,
        pickCurrentBook,
        inlineStrip,
        css: CSS,
      },
      apply(ctx) {
        // The panel must be styled even before its slot is first rendered:
        // install the sheet as soon as the plugin activates.
        ensureStyles()

        navigateToPanel = (id) => {
          try {
            ctx.get('layout')?.selectPanel?.(id)
          } catch {
            /* the layout service may be absent in tests */
          }
        }

        ctx.effect(
          () => ctx.locale.register(NS, { zh, en }),
          'dsh-novels: locale',
        )

        const bind = ctx.locale.bind(NS)
        /** Locale text with the bundled dictionary as the last resort. */
        const tr = (key) => {
          try {
            const text = bind(key)
            if (text && text !== key) return text
          } catch {
            /* the locale service may not be bound yet */
          }
          return zh[key] ?? en[key] ?? key
        }
        const makeT = (slotT) => (key) => {
          if (typeof slotT === 'function') {
            const text = slotT(key)
            if (text && text !== key) return text
          }
          return tr(key)
        }

        // Sidebar entry + main panel are two cells of the same id: the sidebar
        // owns the button, `main` renders the panel for that id.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: SLOT_ID,
              order: 20,
              label: () => tr('nav'),
              locale: NS,
            },
            (owner) =>
              h(
                'span',
                {
                  className: 'dnv-iconHit',
                  // The shell's row selects a main panel on click. Stop it here:
                  // the icon only toggles the strip, so the chat never moves.
                  onClick: (event) => {
                    event.stopPropagation()
                    inlineStrip.toggle()
                  },
                },
                h(NovelsIcon, { size: owner?.size ?? 16, active: owner?.active === true }),
              ),
          ),
        )

        // The sidebar button's panel: flip the strip and give the centre column
        // back to the conversation, so clicking the icon never opens a page.
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: SLOT_ID, locale: NS }, () => h(InlineToggle)),
        )

        // The full shelf/reader, opened by double-clicking the strip.
        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: FULL_PANEL_KEY, locale: NS },
            (slotProps) => h(NovelsPanel, { t: makeT(slotProps?.t) }),
          ),
        )

        // Five anonymous lines (or the book picker) between the transcript and
        // the composer.
        ctx.slots.inject('conversation.input.dock', () =>
          ctx.slots.register(
            { name: 'conversation.input.dock', id: INLINE_SLOT_ID, order: 30, locale: NS },
            (slotProps) => h(InlineDock, { t: makeT(slotProps?.t) }),
          ),
        )

        // One load-time probe: the Host log records it, so a broken build shows
        // up there before the panel is ever opened.
        ctx.effect(() => {
          fetchJson('ping')
            .then((result) => {
              console.debug(
                `[dsh-novels] host probe: HTTP ${result.status}` +
                  (result.ok && result.body ? ` dataDir=${result.body.dataDir ?? '—'}` : ` ${result.body?.message ?? ''}`),
              )
            })
            .catch((error) => console.debug('[dsh-novels] host probe failed:', error))
        }, 'dsh-novels: host probe')

        // If the plugin is unloaded while its panel is open, fall back to the
        // conversation panel instead of leaving a dangling key selected.
        ctx.effect(
          () => () => {
            try {
              const layout = ctx.get('layout')
              const active = layout?.panelInfo?.getSnapshot?.().activePanelId
              if (active === SLOT_ID || active === FULL_PANEL_KEY) layout.selectPanel(null)
            } catch {
              /* layout may be gone during teardown */
            }
          },
          'dsh-novels: panel teardown',
        )
      },
    }
  },
})
