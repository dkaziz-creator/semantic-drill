import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_DATABASE } from '../config.js'
import { createStudyServer } from '../app.js'
import { CouchClient, CouchError } from '../couch/client.js'
import { provisionUser } from '../couch/provisioning.js'
import { createSession, resolveSession, sessionId } from '../auth/sessions.js'
import { verifyPassword } from '../auth/passwords.js'
import type { User } from '../auth/users.js'
import { close, fakeCouch, listen, testConfig } from './helpers.js'

const TEMPORARY = 'temporary test-only password'
const PERMANENT = 'permanent test-only password'
let fake: ReturnType<typeof fakeCouch>
let couch: CouchClient
let server: Server
let base: string
let user: User

beforeEach(async () => {
  fake = fakeCouch()
  couch = new CouchClient(testConfig(await listen(fake.server)))
  user = await provisionUser(couch, { login: 'new-pilot', displayName: 'Pilot', password: TEMPORARY })
  server = createStudyServer(couch.config)
  base = await listen(server)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await close(server)
  await close(fake.server)
})

const cookieOf = (response: Response) => response.headers.get('set-cookie')?.split(';')[0] ?? ''
const tokenOf = (cookie: string) => cookie.slice('study_session='.length)
const storedUser = () => fake.databases.get(AUTH_DATABASE)!.get(user._id)!
const sessions = () => [...fake.databases.get(AUTH_DATABASE)!.values()].filter((doc) => doc.type === 'session')
function post(path: string, cookie = '', body?: unknown, extraHeaders?: Record<string, string>) {
  return fetch(base + '/api/auth/' + path, { method: 'POST', headers: {
    Cookie: cookie, Origin: couch.config.publicOrigin, 'Content-Type': 'application/json', ...extraHeaders,
  }, body: body === undefined ? undefined : JSON.stringify(body) })
}
const login = (cookie = '', password = TEMPORARY) => post('login', cookie, { login: user.login, password })
const state = async (cookie = '') => {
  const response = await fetch(base + '/api/auth/state', { headers: { Cookie: cookie } })
  expect(response.headers.get('cache-control')).toBe('no-store')
  return response.json()
}
const me = (cookie: string) => fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })
function gateway(cookie: string, path = '_all_docs', method = 'GET', body?: string) {
  return fetch(base + '/couchdb/my/' + path, { method, body, headers: {
    Cookie: cookie, 'X-Study-User': user.userId, Origin: couch.config.publicOrigin, 'Content-Type': 'application/json',
  } })
}

describe('temporary password provisioning and session purposes', () => {
  it('provisions a temporary password and preserves it and its state across resume', async () => {
    expect(user.mustChangePassword).toBe(true)
    storedUser().enabled = false
    storedUser().provisioned = false
    const resumed = await provisionUser(couch, { login: user.login, resume: true, password: PERMANENT })
    expect(resumed).toMatchObject({ userId: user.userId, mustChangePassword: true, password: user.password })
    await expect(provisionUser(couch, { login: user.login, password: PERMANENT })).rejects.toThrow('already exists')
    expect(storedUser().password).toEqual(user.password)
    expect(storedUser().mustChangePassword).toBe(true)
  })

  it('issues only a restricted session after valid temporary credentials and rotates safely', async () => {
    expect(await state()).toEqual({ authenticated: false })
    const first = await login()
    const restricted = cookieOf(first)
    expect(await first.json()).toEqual({ status: 'password_change_required' })
    expect(sessions()).toHaveLength(1)
    expect(sessions()[0]).toMatchObject({ purpose: 'change-password', userId: user.userId })
    expect(await state(restricted)).toEqual({ authenticated: true, mustChangePassword: true })
    const failed = await login(restricted, 'incorrect password')
    expect(failed.status).toBe(401)
    expect(failed.headers.get('set-cookie')).toBe(null)
    expect(await state(restricted)).toEqual({ authenticated: true, mustChangePassword: true })
    const next = await login(restricted)
    expect(cookieOf(next)).not.toBe(restricted)
    expect(await state(restricted)).toEqual({ authenticated: false })
    expect(sessions()).toHaveLength(1)
    const out = await post('logout', cookieOf(next))
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(await state(cookieOf(next))).toEqual({ authenticated: false })
  })

  it('keeps wrong, unknown, disabled and incomplete temporary credentials indistinguishable', async () => {
    const responses = [await login('', 'incorrect password'),
      await post('login', '', { login: 'unknown-pilot', password: TEMPORARY })]
    storedUser().enabled = false
    responses.push(await login())
    storedUser().enabled = true
    storedUser().provisioned = false
    responses.push(await login())
    for (const response of responses) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Invalid login or password.' })
      expect(response.headers.get('set-cookie')).toBe(null)
    }
    expect(sessions()).toHaveLength(0)
  })

  it.each([false, undefined])('accepts permanent and legacy user state %s without first-login lockout', async (flag) => {
    if (flag === undefined) delete storedUser().mustChangePassword
    else storedUser().mustChangePassword = flag
    const response = await login()
    expect(await response.json()).toEqual({ status: 'authenticated', user: { id: user.userId, displayName: 'Pilot' } })
    expect(sessions()[0]!.purpose).toBe('study')
    expect((await me(cookieOf(response))).status).toBe(200)
    expect(await state(cookieOf(response))).toEqual({ authenticated: true, mustChangePassword: false })
    expect((await post('change-password', cookieOf(response), { password: PERMANENT })).status).toBe(401)
  })

  it('requires explicit purpose and retains expiration, disablement, provisioning and UUID checks', async () => {
    const restricted = await createSession(couch, user, 'change-password', 60)
    const study = await createSession(couch, user, 'study', 60)
    expect(await resolveSession(couch, restricted, 'study')).toBe(null)
    expect(await resolveSession(couch, study, 'study')).toBe(null)
    expect(await resolveSession(couch, restricted, 'change-password')).toMatchObject({ userId: user.userId })
    expect(await resolveSession(couch, restricted, 'change-password', Date.now() + 61000)).toBe(null)
    for (const field of ['enabled', 'provisioned']) {
      storedUser()[field] = false
      expect(await resolveSession(couch, restricted, 'change-password')).toBe(null)
      storedUser()[field] = true
    }
    storedUser().userId = '550e8400-e29b-41d4-a716-446655440000'
    expect(await resolveSession(couch, restricted, 'change-password')).toBe(null)
    storedUser().userId = user.userId
    for (const purpose of [undefined, 'unknown']) {
      sessions().find((s) => s._id === sessionId(restricted))!.purpose = purpose
      expect(await resolveSession(couch, restricted, 'change-password')).toBe(null)
      expect(await resolveSession(couch, restricted, 'study')).toBe(null)
    }
  })

  it('denies /me and every learning operation before contacting a learning database', async () => {
    const restricted = cookieOf(await login())
    expect((await me(restricted)).status).toBe(401)
    const before = fake.requests.filter((r) => r.path.startsWith('/semantic-drill-user-')).length
    const operations = [
      ['', 'GET'], ['', 'HEAD'], ['_all_docs', 'GET'], ['_all_docs', 'POST'],
      ['_changes?feed=longpoll', 'GET'], ['_changes', 'POST'], ['_bulk_docs', 'POST'],
      ['_bulk_get', 'POST'], ['_revs_diff', 'POST'], ['quiz:one', 'GET'], ['quiz:one', 'PUT'],
      ['quiz:one', 'DELETE'], ['quiz:one/attachment', 'GET'], ['_local/checkpoint', 'PUT'],
    ] as const
    for (const [path, method] of operations) {
      expect((await gateway(restricted, path, method, ['POST', 'PUT'].includes(method) ? '{}' : undefined)).status, path).toBe(401)
    }
    expect(fake.requests.filter((r) => r.path.startsWith('/semantic-drill-user-'))).toHaveLength(before)
  })
})

describe('password change transition', () => {
  it('replaces the hash, invalidates all restricted sessions and issues a fresh study session', async () => {
    const restricted = cookieOf(await login())
    const otherRestricted = cookieOf(await login())
    const response = await post('change-password', restricted, { password: PERMANENT })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'authenticated', user: { id: user.userId, displayName: 'Pilot' } })
    expect(response.headers.get('set-cookie')).toContain('HttpOnly; SameSite=Strict; Path=/; Max-Age=604800; Secure')
    const study = cookieOf(response)
    expect(study).not.toBe(restricted)
    expect(storedUser().mustChangePassword).toBe(false)
    expect(storedUser().password).not.toEqual(user.password)
    expect(await verifyPassword(PERMANENT, storedUser().password)).toBe(true)
    expect(await verifyPassword(TEMPORARY, storedUser().password)).toBe(false)
    expect(fake.databases.get(AUTH_DATABASE)!.has(sessionId(tokenOf(restricted))!)).toBe(false)
    for (const cookie of [restricted, otherRestricted]) {
      expect(await state(cookie)).toEqual({ authenticated: false })
      expect((await me(cookie)).status).toBe(401)
      expect((await gateway(cookie)).status).toBe(401)
      expect((await post('change-password', cookie, { password: 'another new password' })).status).toBe(401)
    }
    expect((await me(study)).status).toBe(200)
    expect(await (await me(study)).json()).toEqual({ id: user.userId, displayName: 'Pilot' })
    expect((await gateway(study)).status).toBe(200)
    expect((await gateway(study, 'quiz:new', 'PUT', '{"value":1}')).status).toBe(201)
    expect((await login('', TEMPORARY)).status).toBe(401)
    const nextLogin = await login('', PERMANENT)
    expect(nextLogin.status).toBe(200)
    expect((await nextLogin.json()).status).toBe('authenticated')
    expect((await me(cookieOf(nextLogin))).status).toBe(200)
  })

  it('validates JSON, password policy, actual password change, origin and Fetch Metadata without mutating state', async () => {
    const restricted = cookieOf(await login())
    for (const body of [null, {}, { password: 123 }, { password: 'short' }, { password: 'x'.repeat(1025) },
      { password: 'é'.repeat(513) }, { password: TEMPORARY }]) {
      const response = await post('change-password', restricted, body)
      expect(response.status).toBe(400)
      expect(response.headers.get('set-cookie')).toBe(null)
    }
    expect((await post('change-password', restricted, { password: PERMANENT }, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('change-password', restricted, { password: PERMANENT }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await post('change-password', restricted, { password: PERMANENT }, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post('change-password?password=' + encodeURIComponent(PERMANENT), restricted, {})).status).toBe(400)
    expect((await post('change-password', '', { password: PERMANENT })).status).toBe(401)
    expect(storedUser().password).toEqual(user.password)
    expect(storedUser().mustChangePassword).toBe(true)
    expect(await state(restricted)).toEqual({ authenticated: true, mustChangePassword: true })
  })

  it('refuses a revision conflict without overwriting concurrent metadata and permits an explicit retry', async () => {
    const restricted = cookieOf(await login())
    const put = CouchClient.prototype.put
    const spy = vi.spyOn(CouchClient.prototype, 'put').mockImplementation(function (this: CouchClient, database, id, value) {
      if (id === user._id) {
        storedUser().displayName = 'Concurrent edit'
        storedUser()._rev = '999-concurrent'
      }
      return put.call(this, database, id, value)
    })
    const response = await post('change-password', restricted, { password: PERMANENT })
    spy.mockRestore()
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: 'Account changed. Please retry or sign in again.' })
    expect(response.headers.get('set-cookie')).toBe(null)
    expect(storedUser().displayName).toBe('Concurrent edit')
    expect(storedUser().password).toEqual(user.password)
    expect(storedUser().mustChangePassword).toBe(true)
    expect((await post('change-password', restricted, { password: PERMANENT })).status).toBe(200)
    expect(storedUser().displayName).toBe('Concurrent edit')
  })

  it('allows only one concurrent password change to win', async () => {
    const restricted = cookieOf(await login())
    const passwords = [PERMANENT, 'another permanent password']
    const results = await Promise.all(passwords.map((password) => post('change-password', restricted, { password })))
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    const winner = results.findIndex((r) => r.status === 200)
    const loser = results[1 - winner]!
    expect([401, 409]).toContain(loser.status)
    expect(loser.headers.get('set-cookie')).toBe(null)
    expect(await verifyPassword(passwords[winner]!, storedUser().password)).toBe(true)
    expect(await verifyPassword(passwords[1 - winner]!, storedUser().password)).toBe(false)
    expect(sessions().filter((s) => s.purpose === 'study')).toHaveLength(1)
  })

  it.each(['revoke', 'create'])('fails closed if session %s fails after the password commit; new credentials recover', async (stage) => {
    const restricted = cookieOf(await login())
    const request = CouchClient.prototype.request
    const spy = vi.spyOn(CouchClient.prototype, 'request').mockImplementation(function (this: CouchClient, method, path, body) {
      if (path.includes('/session%3A') && method === (stage === 'revoke' ? 'DELETE' : 'PUT')) {
        return Promise.reject(new CouchError(503))
      }
      return request.call(this, method, path, body)
    })
    const response = await post('change-password', restricted, { password: PERMANENT })
    spy.mockRestore()
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'Study service unavailable.' })
    expect(response.headers.get('set-cookie')).toBe(null)
    expect(storedUser().mustChangePassword).toBe(false)
    expect(await state(restricted)).toEqual({ authenticated: false })
    expect((await gateway(restricted)).status).toBe(401)
    expect((await post('change-password', restricted, { password: 'another new password' })).status).toBe(401)
    expect((await login('', TEMPORARY)).status).toBe(401)
    const recovered = await login(restricted, PERMANENT)
    expect(recovered.status).toBe(200)
    expect((await me(cookieOf(recovered))).status).toBe(200)
  })
})
