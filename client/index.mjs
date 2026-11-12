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
    const VERSION = '0.1.0'
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

      if (!unique.length) return splitByLength(body)
      if (unique[0].start > 0) unique.unshift({ title: '开篇', start: 0 })

      // A heading followed by almost nothing is usually a false positive (a
      // table of contents, a stray subtitle). Dropping it lets the previous
      // chapter absorb those characters. The final chapter is always kept so a
      // short ending ("尾声") never loses its title.
      const kept = [unique[0]]
      for (let i = 1; i < unique.length; i += 1) {
        const current = unique[i]
        const next = unique[i + 1]
        if (next && next.start - current.start < MIN_CHAPTER_CHARS) continue
        kept.push(current)
      }
      return kept
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
.dnv-chapterTitle{font-size:1.28em;font-weight:600;margin:0 0 .9em;line-height:1.5}
.dnv-text{white-space:pre-wrap;word-break:break-word;margin:0;font-family:var(--dnv-font,Georgia,"Songti SC","Source Han Serif SC",serif)}
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
      if (typeof document.querySelector === 'function' && document.querySelector(selector)) return true
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', CSS_TAG)
      tag.textContent = CSS
      head.appendChild(tag)
      return true
    }

    /* --------------------------------------------------------------- shelf -- */

    function BookCard({ book, t, onOpen, onDelete, onRename, busy }) {
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
            { type: 'button', className: 'dnv-btn dnv-btn-ghost', disabled: busy, onClick: () => onDelete(book) },
            t('remove'),
          ),
        ),
      )
    }

    function Shelf({ t, state, onUpload, onOpen, onDelete, onRename, onRefresh, busyBookId }) {
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
      const current = chapters[index] ?? { title: '', start: 0 }
      const chapterText = React.useMemo(() => {
        if (typeof text !== 'string') return ''
        const start = Math.max(0, current.start ?? 0)
        const end = index + 1 < total ? Math.max(start, chapters[index + 1].start) : text.length
        return text.slice(start, end)
      }, [text, chapters, index, total, current.start])

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
          setLibrary({ loading: false, books: result.body.books ?? [], prefs: result.body.prefs ?? null, error: null, notice: notice ?? null })
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

      const changePrefs = React.useCallback(async (patch) => {
        setLibrary((state) => ({ ...state, prefs: { ...(state.prefs ?? {}), ...patch } }))
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
        onRefresh: () => loadLibrary(),
        busyBookId,
      })
    }

    return {
      name: 'dsh-novels',
      inject: ['slots', 'locale'],
      /** Node-side tests reach the pure text pipeline through this. */
      testHooks: { decodeBytes, normalizeText, splitChapters, groupChapters, fittedReaderHeight, css: CSS },
      apply(ctx) {
        // The panel must be styled even before its slot is first rendered:
        // install the sheet as soon as the plugin activates.
        ensureStyles()

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
            (owner) => h(NovelsIcon, { size: owner?.size ?? 16, active: owner?.active === true }),
          ),
        )

        ctx.slots.inject('main', () =>
          ctx.slots.register(
            { name: 'main', key: SLOT_ID, locale: NS },
            (slotProps) => h(NovelsPanel, { t: makeT(slotProps?.t) }),
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
              if (layout?.panelInfo?.getSnapshot?.().activePanelId === SLOT_ID) layout.selectPanel(null)
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
