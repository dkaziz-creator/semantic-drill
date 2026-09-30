import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Config } from './config.js'
import { CouchClient } from './couch/client.js'
import { createGateway, gatewayPath } from './couch/gateway.js'
import { validPassword, verifyPassword } from './auth/passwords.js'
import { createSession, resolveSession, revokeSession } from './auth/sessions.js'
import { findUser, normalizeLogin, publicIdentity } from './auth/users.js'
import { LoginLimiter } from './auth/rateLimiter.js'
import { cookie, sessionCookie } from './http/cookies.js'
import { checkOrigin, HttpError, json, readJson } from './http/security.js'
import { serveStatic } from './http/static.js'

export function createStudyServer(config: Config, options: {
  staticDirectory?: string
  log?: (entry: Record<string, unknown>) => void
} = {}) {
  const couch = new CouchClient(config)
  const gateway = createGateway(couch)
  const limiter = new LoginLimiter()
  let activeLogins = 0
  const server = createServer({ maxHeaderSize: 16384 }, (request, response) => {
    const started = Date.now()
    const requestId = randomUUID()
    const target = request.url ?? ''
    const path = target.split('?')[0]
    const isGateway = path === '/couchdb/my' || path?.startsWith('/couchdb/my/')
    const category = isGateway ? 'gateway' : path?.startsWith('/api/auth/') ? 'auth' : 'static'
    let userId: string | undefined
    response.setHeader('X-Request-Id', requestId)
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'same-origin')
    response.setHeader('X-Frame-Options', 'DENY')
    response.on('finish', () => options.log?.({ requestId, method: request.method, category,
      status: response.statusCode, userId, durationMs: Date.now() - started }))

    void (async () => {
      const token = sessionCookie(request.headers.cookie)
      if (request.method === 'POST' && path === '/api/auth/login') {
        checkOrigin(request, config)
        const body = await readJson(request)
        let login: string
        let password: string
        try {
          if (!body || typeof body !== 'object' || !('login' in body) || !('password' in body)) throw new Error()
          login = normalizeLogin(body.login)
          if (!validPassword(body.password)) throw new Error()
          password = body.password
        } catch { throw new HttpError(401, 'Invalid login or password.') }
        const address = request.socket.remoteAddress ?? 'unknown'
        if (!limiter.take(address, login) || activeLogins >= 4) {
          response.setHeader('Retry-After', '300')
          throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
        }
        activeLogins++
        try {
          const user = await findUser(couch, login)
          const valid = await verifyPassword(password, user?.password)
          if (!valid || !user?.enabled || !user.provisioned) throw new HttpError(401, 'Invalid login or password.')
          // Rotate the browser's old session only after credentials have been verified.
          await revokeSession(couch, token)
          const nextToken = await createSession(couch, user, config.sessionMaxAge)
          response.setHeader('Set-Cookie', cookie(nextToken, config))
          limiter.success(address, login)
          userId = user.userId
          json(response, 200, publicIdentity(user))
        } finally { activeLogins-- }
        return
      }
      if (request.method === 'POST' && path === '/api/auth/logout') {
        checkOrigin(request, config)
        await revokeSession(couch, token)
        response.setHeader('Set-Cookie', cookie('', config, true))
        json(response, 200, { ok: true })
        return
      }
      if ((request.method === 'GET' && path === '/api/auth/me') || isGateway) {
        if (isGateway && !['GET', 'HEAD'].includes(request.method ?? '')) checkOrigin(request, config)
        const user = await resolveSession(couch, token)
        if (!user) throw new HttpError(401, 'Sign in required.')
        userId = user.userId
        if (!isGateway) { json(response, 200, publicIdentity(user)); return }
        if (request.headers['x-study-user'] !== user.userId) throw new HttpError(403, 'Study identity mismatch.')
        const upstreamPath = gatewayPath(target, request.method ?? '', user.userId)
        if (!response.destroyed && !request.destroyed) gateway.proxy(request, response, upstreamPath)
        return
      }
      if (path?.startsWith('/api/') || path?.startsWith('/couchdb') || !options.staticDirectory) throw new HttpError(404, 'Unknown route.')
      await serveStatic(request, response, options.staticDirectory)
    })().catch((error: unknown) => {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      json(response, error instanceof HttpError ? error.status : 503,
        { error: error instanceof HttpError ? error.message : 'Study service unavailable.' })
    })
  })
  // Do not apply API request/idle deadlines to long polls or streaming uploads.
  server.requestTimeout = 0
  server.timeout = 0
  server.headersTimeout = 15000
  server.on('close', () => gateway.close())
  return server
}
