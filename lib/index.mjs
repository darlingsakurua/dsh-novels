/**
 * dsh-novels — Host half.
 *
 * Registers the plugin's HTTP surface under `/dsh-novels/api/v1` and hands the
 * actual bookkeeping to `lib/store.mjs`. Every request is gated exactly like
 * the shipped `/api` channel: no `connection` service, no access.
 *
 * Route table (all JSON unless noted):
 *   GET    /ping                 diagnostics
 *   GET    /library              index: books + prefs
 *   POST   /books                upload {name, text, encoding, chapters}
 *   GET    /books/{id}           book + chapter offsets
 *   GET    /books/{id}/text      full body as text/plain
 *   PATCH  /books/{id}           rename
 *   PATCH  /books/{id}/progress  reading position
 *   DELETE /books/{id}           remove book and its files
 *   PATCH  /prefs                reader prefs
 */
import { basename, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'

import { createStore, isBookId, sanitizePrefs, StoreError } from './store.mjs'

const PLUGIN_NAME = 'dsh-novels'
const API_PREFIX = '/dsh-novels/api/v1'

/**
 * Version comes from package.json so the ready log and /ping can never drift
 * from what the marketplace installed. Reading it once at module load is safe:
 * the file ships inside the package the Host already resolved.
 */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Uploads carry the whole body as JSON, so the ceiling is generous but hard. */
const LIMIT_UPLOAD = 24 * 1024 * 1024
const LIMIT_SMALL = 64 * 1024

/** Cordis fiber metadata: the route handler needs the web server service. */
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const profile = resolveCurrentProfile(ctx)
  const dataDir = join(profile.profileDir, 'plugin-data', PLUGIN_NAME)

  let dataDirError = null
  let store = null
  try {
    store = createStore(dataDir)
  } catch (error) {
    dataDirError = messageOf(error)
  }

  log(
    ctx,
    `v${VERSION} ready · profile=${profile.name} · data=${dataDir} · route=${API_PREFIX}/…` +
      (dataDirError ? ` (storage failed: ${dataDirError})` : ''),
  )

  ctx.effect(() => {
    // The prefix is registered WITHOUT a trailing slash: the web server matches
    // `pathname === prefix || pathname.startsWith(prefix + '/')`, so a trailing
    // slash would only ever match the bare prefix itself.
    const dispose = ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => {
        const state = { profile, dataDir, dataDirError, store }
        const settled = handleApi(ctx, req, res, state).catch((error) => {
          if (!respondError(res, error)) log(ctx, `unhandled ${describe(req)}: ${messageOf(error)}`)
        })
        // One line per request keeps later phases debuggable from the log alone.
        settled.then(() => log(ctx, `${describe(req)} -> ${res.statusCode}`))
      },
    })
    return () => {
      dispose()
    }
  }, 'dsh-novels: api routes')
}

/* ------------------------------------------------------------------ routes -- */

async function handleApi(ctx, req, res, state) {
  const rejection = checkConnection(ctx, req)
  if (rejection) return sendError(res, rejection.status, rejection.error, rejection.message)

  const { method, path } = parseRequest(req)

  if (method === 'GET' && oneOf(path, '/ping', '/ping/')) return sendPing(res, state)
  if (!state.store) {
    return sendError(res, 503, 'storage-unavailable', `数据目录不可用: ${state.dataDirError ?? '未知原因'}`)
  }
  if (method === 'GET' && oneOf(path, '/library', '/library/')) return sendLibrary(res, state)
  if (method === 'PATCH' && oneOf(path, '/prefs', '/prefs/')) return patchPrefs(req, res, state)
  if (method === 'POST' && oneOf(path, '/books', '/books/')) return createBook(req, res, state)

  const match = /^\/books\/([^/]+)(\/[a-z]+)?\/?$/.exec(path)
  if (match) {
    const [, rawId, sub] = match
    if (!isBookId(rawId)) return sendError(res, 400, 'invalid-id', '非法的书籍 id')
    const book = state.store ? state.store.getBook(rawId) : null

    if (!sub) {
      if (method === 'GET') return sendBook(res, state, rawId, book)
      if (method === 'PATCH') return patchBook(req, res, state, rawId, book)
      if (method === 'DELETE') return deleteBook(res, state, rawId, book)
    }
    if (sub === '/text' && method === 'GET') return sendText(res, state, rawId, book)
    if (sub === '/progress' && method === 'PATCH') return patchProgress(req, res, state, rawId, book)
  }

  return sendError(res, 404, 'not-found', `未知接口: ${method} ${path}`)
}

function sendPing(res, state) {
  sendJson(res, 200, {
    ok: true,
    pong: true,
    version: VERSION,
    plugin: PLUGIN_NAME,
    profile: state.profile.name,
    profileDir: state.profile.profileDir,
    dataDir: state.dataDir,
    dataDirReady: state.dataDirError === null,
    dataDirError: state.dataDirError,
    bookCount: state.store ? state.store.load().books.length : 0,
    pid: process.pid,
    now: new Date().toISOString(),
  })
}

function sendLibrary(res, state) {
  const library = state.store.load()
  sendJson(res, 200, { ok: true, books: library.books, prefs: library.prefs, version: library.version })
}

async function createBook(req, res, state) {
  const body = await readJson(req, LIMIT_UPLOAD)
  if (!body || typeof body !== 'object') return sendError(res, 400, 'invalid-body', '请求体必须是 JSON 对象')
  if (typeof body.text !== 'string') return sendError(res, 400, 'invalid-text', '缺少正文 text')
  if (!body.text.trim()) return sendError(res, 400, 'empty-text', '正文为空，无法导入')

  const book = state.store.createBook({
    name: typeof body.name === 'string' ? body.name : '',
    text: body.text,
    encoding: typeof body.encoding === 'string' ? body.encoding : 'UTF-8',
    chapters: body.chapters,
    author: typeof body.author === 'string' ? body.author : '',
  })
  sendJson(res, 200, { ok: true, book })
}

function sendBook(res, state, id, book) {
  if (!book) return sendError(res, 404, 'book-not-found', '书不存在或已删除')
  let chapters = []
  try {
    chapters = state.store.readChapters(id)
  } catch {
    chapters = []
  }
  sendJson(res, 200, { ok: true, book, chapters })
}

function sendText(res, state, id, book) {
  if (!book) return sendError(res, 404, 'book-not-found', '书不存在或已删除')
  let text = ''
  try {
    text = state.store.readText(id)
  } catch (error) {
    return sendError(res, 410, 'text-missing', `正文文件缺失: ${messageOf(error)}`)
  }
  if (res.writableEnded) return undefined
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function patchBook(req, res, state, id, book) {
  if (!book) return sendError(res, 404, 'book-not-found', '书不存在或已删除')
  const body = await readJson(req, LIMIT_SMALL)
  const updated = state.store.updateBook(id, {
    title: typeof body?.title === 'string' ? body.title : undefined,
    author: typeof body?.author === 'string' ? body.author : undefined,
  })
  sendJson(res, 200, { ok: true, book: updated })
}

async function patchProgress(req, res, state, id, book) {
  if (!book) return sendError(res, 404, 'book-not-found', '书不存在或已删除')
  const body = await readJson(req, LIMIT_SMALL)
  const updated = state.store.updateProgress(id, {
    chapterIndex: body?.chapterIndex,
    offsetChars: body?.offsetChars,
    percent: body?.percent,
  })
  sendJson(res, 200, { ok: true, progress: updated.progress })
}

function deleteBook(res, state, id, book) {
  if (!book) return sendError(res, 404, 'book-not-found', '书不存在或已删除')
  state.store.deleteBook(id)
  sendJson(res, 200, { ok: true, id })
}

async function patchPrefs(req, res, state) {
  const body = await readJson(req, LIMIT_SMALL)
  const prefs = state.store.updatePrefs(sanitizePrefs({ ...state.store.prefs(), ...(body ?? {}) }))
  sendJson(res, 200, { ok: true, prefs })
}

/* ----------------------------------------------------------------- helpers -- */

/**
 * Everything the connection plugin admits, this API admits. When the security
 * channel is missing entirely we refuse the request instead of silently
 * exposing an unauthenticated endpoint.
 */
function checkConnection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') {
    return { status: 503, error: 'connection-unavailable', message: 'connection service 未就绪，暂时拒绝该请求' }
  }
  try {
    const status = connection.requestRejection(req)
    if (status === 401) return { status, error: 'login-required', message: '请先登录后再访问小说接口' }
    if (status === 403) return { status, error: 'untrusted-request', message: '请求来源未通过校验' }
  } catch (error) {
    return { status: 503, error: 'connection-unavailable', message: `connection 校验失败: ${messageOf(error)}` }
  }
  return null
}

/**
 * Prefix routes may or may not strip the mount path before invoking the
 * handler. Tolerate both so routing never depends on that detail.
 */
function parseRequest(req) {
  const raw = req.url ?? '/'
  const queryAt = raw.indexOf('?')
  let pathname = queryAt === -1 ? raw : raw.slice(0, queryAt)
  if (pathname.startsWith(API_PREFIX)) pathname = pathname.slice(API_PREFIX.length) || '/'
  return { method: (req.method ?? 'GET').toUpperCase(), path: pathname || '/' }
}

/** Bounded JSON body reader: `content-length` first, then a running total. */
async function readJson(req, limit) {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > limit) throw new ApiError(413, 'too-large', '请求体过大')

  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new ApiError(413, 'too-large', '请求体过大')
    chunks.push(chunk)
  }
  if (!total) return null
  const text = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    throw new ApiError(400, 'invalid-json', '请求体不是合法 JSON')
  }
}

class ApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function oneOf(value, ...candidates) {
  return candidates.includes(value)
}

/**
 * Map a thrown error onto the documented envelope. Returns false when the
 * error was not ours, so the caller can log it as an unhandled failure.
 */
function respondError(res, error) {
  if (res.writableEnded) return true
  if (error instanceof ApiError) {
    sendError(res, error.status, error.code, error.message)
    return true
  }
  if (error instanceof StoreError) {
    const clientFault = error.code === 'invalid-id' || error.code === 'invalid-text' || error.code === 'empty-text'
    sendError(res, clientFault ? 400 : 500, error.code, error.message)
    return true
  }
  sendError(res, 500, 'internal-error', messageOf(error))
  return false
}

function sendJson(res, status, body) {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function sendError(res, status, error, message) {
  sendJson(res, status, { ok: false, error, message })
}

function describe(req) {
  return `${req.method ?? 'GET'} ${req.url ?? '/'}`
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function log(ctx, message) {
  try {
    ctx?.logger?.info?.(`[${PLUGIN_NAME}] ${message}`)
  } catch {
    /* logging must never break the plugin */
  }
}

/**
 * Resolve the profile that is actually running, in the same order the shipped
 * clients use: profileContext service → DSH_PROFILE_DIR → --profile → DSH_PROFILE
 * → 'web'. The data directory hangs off the resulting profile directory.
 */
function resolveCurrentProfile(ctx) {
  const homeDir = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME : join(homedir(), '.dsh')

  const launched = ctx.get('profileContext')
  const launchedName = typeof launched?.name === 'string' && launched.name.trim() ? launched.name.trim() : null
  const launchedDir = typeof launched?.dir === 'string' && isAbsolute(launched.dir) ? launched.dir : null

  const dirFromEnv = isAbsolute(process.env.DSH_PROFILE_DIR ?? '') ? process.env.DSH_PROFILE_DIR : null
  const nameFromArgv = readProfileArg(process.argv)
  const nameFromEnv = process.env.DSH_PROFILE && process.env.DSH_PROFILE.trim() ? process.env.DSH_PROFILE.trim() : null

  const profileDir = launchedDir ?? dirFromEnv ?? join(homeDir, 'profiles', launchedName ?? nameFromArgv ?? nameFromEnv ?? 'web')
  return { name: launchedName ?? nameFromArgv ?? nameFromEnv ?? basename(profileDir) ?? 'web', profileDir: resolve(profileDir) }
}

function readProfileArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile' && typeof argv[i + 1] === 'string' && argv[i + 1].trim() && !argv[i + 1].startsWith('-')) {
      return argv[i + 1].trim()
    }
    if (arg.startsWith('--profile=')) {
      const value = arg.slice('--profile='.length).trim()
      if (value) return value
    }
  }
  return null
}
