import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { AUTH_DATABASE, type Config } from './config.js'
import { CouchClient, CouchError } from './couch/client.js'
import { createGateway, gatewayPath } from './couch/gateway.js'
import { hashPassword, validPassword, verifyPassword } from './auth/passwords.js'
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
  let activePasswordOperations = 0
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
        if (!limiter.take(address, login) || activePasswordOperations >= 4) {
          response.setHeader('Retry-After', '300')
          throw new HttpError(429, 'Too many sign-in attempts. Try again later.')
        }
        activePasswordOperations++
        try {
          const user = await findUser(couch, login)
          const valid = await verifyPassword(password, user?.password)
          if (!valid || !user?.enabled || !user.provisioned) throw new HttpError(401, 'Invalid login or password.')
          // Rotate the browser's old session only after credentials have been verified.
          await revokeSession(couch, token)
          const purpose = user.mustChangePassword === true ? 'change-password' : 'study'
          const nextToken = await createSession(couch, user, purpose, config.sessionMaxAge)
          response.setHeader('Set-Cookie', cookie(nextToken, config))
          limiter.success(address, login)
          userId = user.userId
          json(response, 200, purpose === 'change-password' ? { status: 'password_change_required' }
            : { status: 'authenticated', user: publicIdentity(user) })
        } finally { activePasswordOperations-- }
        return
      }
      if (request.method === 'GET' && path === '/api/auth/state') {
        const restricted = await resolveSession(couch, token, 'change-password')
        const study = restricted ? null : await resolveSession(couch, token, 'study')
        json(response, 200, restricted || study
          ? { authenticated: true, mustChangePassword: !!restricted } : { authenticated: false })
        return
      }
      if (request.method === 'POST' && path === '/api/auth/change-password') {
        checkOrigin(request, config)
        const user = await resolveSession(couch, token, 'change-password')
        if (!user) throw new HttpError(401, 'Password-change sign-in required.')
        const body = await readJson(request)
        if (!body || typeof body !== 'object' || !('password' in body) || !validPassword(body.password)) {
          throw new HttpError(400, 'Password must contain at least 12 characters and at most 1024 UTF-8 bytes.')
        }
        const address = request.socket.remoteAddress ?? 'unknown'
        if (!limiter.take(address, user.login) || activePasswordOperations >= 4) {
          response.setHeader('Retry-After', '300')
          throw new HttpError(429, 'Too many password attempts. Try again later.')
        }
        activePasswordOperations++
        try {
          if (await verifyPassword(body.password, user.password)) {
            throw new HttpError(400, 'Choose a password different from the temporary password.')
          }
          const updated = { ...user, password: await hashPassword(body.password), mustChangePassword: false }
          try {
            // Use the revision resolved above; never overwrite concurrent account changes.
            await couch.put(AUTH_DATABASE, user._id, updated)
          } catch (error) {
            if (error instanceof CouchError && error.status === 409) {
              throw new HttpError(409, 'Account changed. Please retry or sign in again.')
            }
            throw error
          }
          await revokeSession(couch, token)
          const nextToken = await createSession(couch, updated, 'study', config.sessionMaxAge)
          response.setHeader('Set-Cookie', cookie(nextToken, config))
          limiter.success(address, user.login)
          userId = user.userId
          json(response, 200, { status: 'authenticated', user: publicIdentity(user) })
        } finally { activePasswordOperations-- }
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
        const user = await resolveSession(couch, token, 'study')
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
