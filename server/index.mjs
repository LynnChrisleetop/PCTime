import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ApiError, credentials, deviceInput, dailySnapshot, dateKey } from './validation.mjs'
import { AUTH_ERROR, createAuthGate, createLimiter, hashPassword, newSession, tokenHash, verifyPassword } from './security.mjs'
import { openStore } from './store.mjs'

const DEFAULT_DATABASE = fileURLToPath(new URL('./data/pctime.sqlite', import.meta.url))

function readJson(request, maximumBytes, timeoutMs) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase()
  if (contentType !== 'application/json') throw new ApiError(415, '请使用 application/json 请求格式')
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ApiError(415, '不支持压缩请求体')
  const advertised = request.headers['content-length']
  if (advertised && (!/^\d+$/u.test(advertised) || Number(advertised) > maximumBytes)) throw new ApiError(413, '请求体超过大小限制')
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const cleanup = () => {
      clearTimeout(timer)
      request.off('data', onData)
      request.off('end', onEnd)
      request.off('aborted', onAbort)
      request.off('error', onAbort)
    }
    const fail = (error) => { cleanup(); reject(error) }
    const onData = (chunk) => {
      size += chunk.length
      if (size > maximumBytes) { fail(new ApiError(413, '请求体超过大小限制')); return }
      chunks.push(chunk)
    }
    const onEnd = () => {
      cleanup()
      try {
        // Fatal UTF-8 decoding avoids silently altering names or passwords.
        const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
        resolve(JSON.parse(decoded))
      } catch { reject(new ApiError(400, '请求体不是有效的 JSON')) }
    }
    const onAbort = () => fail(new ApiError(400, '请求未完成'))
    const timer = setTimeout(() => fail(new ApiError(408, '请求超时')), timeoutMs)
    timer.unref()
    request.on('data', onData)
    request.once('end', onEnd)
    request.once('aborted', onAbort)
    request.once('error', onAbort)
  })
}

function parseOrigins(values) {
  return new Set(values.map((value) => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value !== url.origin) {
      throw new Error('Allowed origins must be exact HTTP(S) origins without a trailing slash')
    }
    return url.origin
  }))
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error('Invalid server configuration')
  return number
}

/**
 * No external packages or Electron dependencies. Factory options provide isolated
 * database paths, a clock, and bounded rate settings for integration tests.
 * Native clients omit Origin; browser origins must be explicitly allowed.
 */
export function createCloudServer(options = {}) {
  const now = options.now ?? Date.now
  const maxBodyBytes = positiveInteger(options.maxBodyBytes, 4 * 1024 * 1024, 16 * 1024 * 1024)
  const bodyTimeoutMs = positiveInteger(options.bodyTimeoutMs, 10000, 60000)
  const allowedOrigins = parseOrigins(options.allowedOrigins ?? [])
  const dbPath = options.dbPath ?? DEFAULT_DATABASE
  const rateOptions = options.rateLimits ?? {}
  const requestWindowMs = positiveInteger(rateOptions.requestWindowMs, 60000, 24 * 60 * 60000)
  const authWindowMs = positiveInteger(rateOptions.authWindowMs, 15 * 60000, 24 * 60 * 60000)
  const requests = createLimiter({ limit: positiveInteger(rateOptions.requests, 600, 100000), windowMs: requestWindowMs, now })
  const authIps = createLimiter({ limit: positiveInteger(rateOptions.authIp, 30, 100000), windowMs: authWindowMs, now })
  const authEmails = createLimiter({ limit: positiveInteger(rateOptions.authEmail, 10, 100000), windowMs: authWindowMs, now })
  const authGate = createAuthGate(positiveInteger(options.authConcurrency, 4, 16))
  const store = openStore(dbPath)
  const timestamp = () => new Date(now()).toISOString()

  function authenticate(request) {
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization)) throw new ApiError(401, '登录已失效，请重新登录')
    const hash = tokenHash(authorization.slice(7))
    const user = store.sessionUser(hash, timestamp())
    if (!user) throw new ApiError(401, '登录已失效，请重新登录')
    return { user, hash }
  }

  function respond(response, status, value) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(value))
  }

  async function route(request, response) {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    const origin = request.headers.origin
    if (origin) {
      response.setHeader('Vary', 'Origin')
      if (!allowedOrigins.has(origin)) throw new ApiError(403, '浏览器来源未获允许')
      response.setHeader('Access-Control-Allow-Origin', origin)
    }
    const ip = request.socket.remoteAddress ?? 'unknown'
    // Ignore X-Forwarded-For. A public caller cannot spoof a fresh rate bucket.
    requests(ip)
    const url = new URL(request.url, 'http://localhost')
    const method = request.method
    if (method === 'OPTIONS') {
      const headers = (request.headers['access-control-request-headers'] ?? '').toLowerCase().split(',').map((value) => value.trim()).filter(Boolean)
      if (!origin || !['GET', 'POST', 'PUT'].includes(request.headers['access-control-request-method']) || headers.some((header) => !['authorization', 'content-type'].includes(header))) throw new ApiError(403, '跨域请求未获允许')
      response.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, PUT',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '600',
      })
      response.end()
      return
    }
    if (method === 'GET' && url.pathname === '/healthz') { respond(response, 200, { ok: true }); return }
    if (method === 'POST' && ['/v1/auth/register', '/v1/auth/login'].includes(url.pathname)) {
      authIps(ip)
      const input = credentials(await readJson(request, Math.min(maxBodyBytes, 16 * 1024), bodyTimeoutMs))
      authEmails(tokenHash(input.email))
      await authGate(async () => {
        let user
        const registering = url.pathname.endsWith('/register')
        if (registering) {
          // Hash even a duplicate registration; errors do not reveal which field
          // failed and database uniqueness still protects simultaneous requests.
          const passwordHash = await hashPassword(input.password)
          user = store.createUser(input.email, passwordHash, timestamp())
          if (!user) throw new ApiError(401, AUTH_ERROR)
        } else {
          const record = store.findUser(input.email)
          if (!await verifyPassword(input.password, record?.password_hash)) throw new ApiError(401, AUTH_ERROR)
          user = { id: record.id, email: record.email }
        }
        const session = newSession(now())
        store.createSession(user.id, session, timestamp())
        respond(response, registering ? 201 : 200, { token: session.token, expiresAt: session.expiresAt, user })
      })
      return
    }
    const { user, hash } = authenticate(request)
    if (method === 'GET' && url.pathname === '/v1/auth/me') { respond(response, 200, { user }); return }
    if (method === 'POST' && url.pathname === '/v1/auth/logout') {
      store.removeSession(hash)
      respond(response, 200, { ok: true })
      return
    }
    if (url.pathname === '/v1/devices' && method === 'GET') { respond(response, 200, { devices: store.listDevices(user.id) }); return }
    if (url.pathname === '/v1/devices' && method === 'POST') {
      const input = deviceInput(await readJson(request, Math.min(maxBodyBytes, 8 * 1024), bodyTimeoutMs))
      respond(response, 200, { device: store.upsertDevice(user.id, input) })
      return
    }
    const dayRoute = /^\/v1\/devices\/([^/]+)\/days\/([^/]+)$/u.exec(url.pathname)
    if (dayRoute && method === 'PUT') {
      const [, deviceId, date] = dayRoute
      store.requireDevice(user.id, deviceId)
      const validDate = dateKey(date)
      const snapshot = dailySnapshot(await readJson(request, maxBodyBytes, bodyTimeoutMs))
      respond(response, 200, store.putDay(user.id, deviceId, validDate, snapshot, timestamp()))
      return
    }
    if (url.pathname === '/v1/summary' && method === 'GET') {
      if ([...url.searchParams.keys()].some((key) => !['date', 'deviceId'].includes(key)) || url.searchParams.getAll('date').length !== 1 || url.searchParams.getAll('deviceId').length > 1) throw new ApiError(400, '统计查询参数无效')
      const date = dateKey(url.searchParams.get('date'))
      const deviceId = url.searchParams.get('deviceId') ?? undefined
      if (deviceId !== undefined && (!deviceId || deviceId.length > 128)) throw new ApiError(400, '设备标识无效')
      respond(response, 200, store.summary(user.id, date, deviceId))
      return
    }
    throw new ApiError(404, '接口不存在')
  }

  const server = http.createServer({ maxHeaderSize: 16 * 1024, requestTimeout: 15000, headersTimeout: 10000, keepAliveTimeout: 5000 }, (request, response) => {
    // An aborted IncomingMessage may emit error after its body listeners have
    // been detached. The body reader handles the failure; never crash the server.
    request.on('error', () => {})
    route(request, response).catch((error) => {
      if (response.headersSent || response.destroyed) return
      const expected = error instanceof ApiError
      if (!expected) {
        try { options.onError?.(error) } catch { /* Logging must not interrupt the error response. */ }
      }
      if (!request.complete) {
        response.setHeader('Connection', 'close')
        request.resume()
      }
      if (error.retryAfter) response.setHeader('Retry-After', String(error.retryAfter))
      respond(response, expected ? error.status : 500, { error: expected ? error.message : '服务器暂时无法处理请求，请稍后重试' })
    })
  })
  server.maxRequestsPerSocket = 100
  server.on('clientError', (error, socket) => {
    if (!socket.writable) return
    const status = error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request'
    const body = JSON.stringify({ error: 'HTTP 请求格式无效' })
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  })
  let closePromise
  return {
    server,
    dbPath,
    async listen(port = 4318, host = '127.0.0.1') {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error)
        server.once('error', onError)
        server.listen(port, host, () => { server.off('error', onError); resolve() })
      })
      const address = server.address()
      return `http://${address.address.includes(':') ? `[${address.address}]` : address.address}:${address.port}`
    },
    close() {
      if (!closePromise) closePromise = (async () => {
        if (server.listening) {
          await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve())
            server.closeIdleConnections()
          })
        }
        store.close()
      })()
      return closePromise
    },
  }
}

export async function runFromEnvironment(env = process.env) {
  const service = createCloudServer({
    dbPath: env.PCTIME_DB_PATH ? path.resolve(env.PCTIME_DB_PATH) : DEFAULT_DATABASE,
    allowedOrigins: (env.PCTIME_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
    onError: (error) => console.error('PCTime cloud request failed:', error.code ?? 'ERR_INTERNAL'),
  })
  try {
    const port = positiveInteger(env.PCTIME_PORT, 4318, 65535)
    const url = await service.listen(port, env.PCTIME_HOST || '127.0.0.1')
    console.log(`PCTime cloud listening at ${url}`)
    return service
  } catch (error) { await service.close(); throw error }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runFromEnvironment().then((service) => {
    const shutdown = () => service.close().catch(() => { process.exitCode = 1 })
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  }).catch((error) => {
    console.error('PCTime cloud could not start:', error.code ?? 'invalid configuration')
    process.exitCode = 1
  })
}
