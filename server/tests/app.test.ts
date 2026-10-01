import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import http, { type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTH_DATABASE } from '../config.js'
import { createStudyServer } from '../app.js'
import { CouchClient } from '../couch/client.js'
import { provisionUser, secureDatabase } from '../couch/provisioning.js'
import { userDatabase, type User } from '../auth/users.js'
import { createSession, resolveSession, revokeSession, sessionId } from '../auth/sessions.js'
import { close, fakeCouch, listen, testConfig } from './helpers.js'

const PASSWORD = 'long test-only password'
let fake: ReturnType<typeof fakeCouch>
let couch: CouchClient
let server: Server
let base: string
let a: User
let b: User
let logs: Record<string, unknown>[]

beforeEach(async () => {
  fake = fakeCouch()
  couch = new CouchClient(testConfig(await listen(fake.server)))
  a = await provisionUser(couch, { login: 'david-test', displayName: 'David', password: PASSWORD })
  b = await provisionUser(couch, { login: 'alex-test', displayName: 'Alex', password: PASSWORD })
  // Existing authentication/gateway regression cases use permanent-password users.
  // Fresh provisioning and the restricted transition are covered separately.
  for (const user of [a, b]) {
    user.mustChangePassword = false
    user._rev = (await couch.put(AUTH_DATABASE, user._id, user)).rev
  }
  logs = []
  server = createStudyServer(couch.config, { log: (entry) => logs.push(entry) })
  base = await listen(server)
})
afterEach(async () => { await close(server); await close(fake.server) })

async function login(user = a, password = PASSWORD) {
  const response = await fetch(base + '/api/auth/login', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: couch.config.publicOrigin },
    body: JSON.stringify({ login: user.login, password }) })
  return { response, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
}
async function session(user: User) { return `study_session=${await createSession(couch, user, 'study', 3600)}` }
function gateway(user: User, cookie: string, path: string, method = 'GET', body?: string) {
  return fetch(base + '/couchdb/my/' + path, { method, body,
    headers: { Cookie: cookie, 'X-Study-User': user.userId, 'Content-Type': 'application/json', Origin: couch.config.publicOrigin } })
}
async function rawRequest(path: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(base, { path, headers: { Cookie: cookie, 'X-Study-User': a.userId } }, (response) => {
      response.resume(); response.on('end', () => resolve(response.statusCode!))
    })
    request.on('error', reject); request.end()
  })
}
const studyRequests = () => fake.requests.filter((r) => r.path.startsWith('/semantic-drill-user-'))

describe('provisioning and sessions', () => {
  it('creates distinct UUID databases with private security and never overwrites logins', async () => {
    expect(a.userId).not.toBe(b.userId)
    expect(fake.securities.get(userDatabase(a.userId))).toEqual({
      admins: { names: ['backend'], roles: ['_admin'] }, members: { names: ['backend'], roles: ['_admin'] },
    })
    expect(fake.securities.get(AUTH_DATABASE)).toEqual(fake.securities.get(userDatabase(a.userId)))
    await expect(provisionUser(couch, { login: ' DAVID-TEST ', displayName: 'Changed', password: 'another password' })).rejects.toThrow('already exists')
    await expect(provisionUser(couch, { login: a.login, resume: true })).rejects.toThrow('already exists')
  })
  it('resumes an incomplete disabled account without changing UUID or password', async () => {
    const stored = fake.databases.get(AUTH_DATABASE)!.get(a._id)!
    stored.enabled = false; stored.provisioned = false
    const resumed = await provisionUser(couch, { login: a.login, resume: true })
    expect(resumed.userId).toBe(a.userId)
    expect(resumed.password).toEqual(a.password)
    expect(resumed.mustChangePassword).toBe(a.mustChangePassword)
    expect(resumed.enabled).toBe(true)
  })
  it('stores only hashes of distinct 256-bit tokens; expires/revokes/disables correctly', async () => {
    const token = await createSession(couch, a, 'study', 60)
    const second = await createSession(couch, a, 'study', 60)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url').length).toBe(32)
    expect(token).not.toBe(second)
    const stored = fake.databases.get(AUTH_DATABASE)!.get(sessionId(token)!)!
    expect(JSON.stringify(stored)).not.toContain(token)
    expect(await resolveSession(couch, token, 'study')).toMatchObject({ userId: a.userId })
    expect(await resolveSession(couch, token, 'study', Date.now() + 61000)).toBe(null)
    await revokeSession(couch, token)
    expect(await resolveSession(couch, token, 'study')).toBe(null)
    await revokeSession(couch, token)
    fake.databases.get(AUTH_DATABASE)!.get(a._id)!.enabled = false
    expect(await resolveSession(couch, second, 'study')).toBe(null)
  })
  it('rejects a session whose UUID no longer matches its login record', async () => {
    const token = await createSession(couch, a, 'study', 60)
    fake.databases.get(AUTH_DATABASE)!.get(a._id)!.userId = b.userId
    expect(await resolveSession(couch, token, 'study')).toBe(null)
  })
})

describe('authentication API', () => {
  it('returns only public identity, sets secure cookie, rotates sessions, and logs no secrets', async () => {
    const { response, cookie } = await login()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: 'authenticated', user: { id: a.userId, displayName: 'David' } })
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800; Secure/)
    const me = await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })
    expect(me.status).toBe(200)
    expect(me.headers.get('cache-control')).toBe('no-store')
    expect(await me.json()).toEqual({ id: a.userId, displayName: 'David' })
    const next = await fetch(base + '/api/auth/login', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: b.login, password: PASSWORD }) })
    expect(next.status).toBe(200)
    expect((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
    expect(JSON.stringify(logs)).not.toContain(PASSWORD)
    expect(JSON.stringify(logs)).not.toContain(cookie.slice('study_session='.length))
    expect(JSON.stringify(logs)).not.toContain(couch.config.couchPassword)
  })
  it('returns identical failures for incorrect, unknown, and disabled credentials', async () => {
    const wrong = await login(a, 'incorrect password')
    const unknown = await login({ ...a, login: 'unknown-user' })
    fake.databases.get(AUTH_DATABASE)!.get(a._id)!.enabled = false
    const disabled = await login()
    for (const { response } of [wrong, unknown, disabled]) {
      expect(response.status).toBe(401)
      expect(await response.json()).toEqual({ error: 'Invalid login or password.' })
      expect(response.headers.get('set-cookie')).toBe(null)
    }
  })
  it('requires a session, revokes on logout, and accepts repeated logout', async () => {
    expect((await fetch(base + '/api/auth/me')).status).toBe(401)
    const { cookie } = await login()
    for (let n = 0; n < 2; n++) {
      const response = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: cookie } })
      expect(response.status).toBe(200)
      expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    }
    expect((await fetch(base + '/api/auth/me', { headers: { Cookie: cookie } })).status).toBe(401)
  })
  it('enforces same-origin on login/logout/mutations and bounds input', async () => {
    const cookie = await session(a)
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/change-password', '/couchdb/my/_bulk_docs']) {
      const response = await fetch(base + path, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://evil.example' } })
      expect(response.status).toBe(403)
    }
    expect((await fetch(base + '/api/auth/login', { method: 'POST', body: '{}' })).status).toBe(415)
    expect((await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
  })
  it('rate limits a login bucket without leaking account existence', async () => {
    for (let n = 0; n < 10; n++) expect((await login(a, 'incorrect password')).response.status).toBe(401)
    const { response } = await login(a, 'incorrect password')
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('300')
  })
})

describe('native per-request gateway', () => {
  it('rejects missing/mismatched identities before any user-database request', async () => {
    const cookie = await session(a)
    const before = studyRequests().length
    for (const id of [undefined, b.userId]) {
      const headers: Record<string, string> = { Cookie: cookie }
      if (id) headers['X-Study-User'] = id
      expect((await fetch(base + '/couchdb/my/_all_docs', { headers })).status).toBe(403)
    }
    expect(studyRequests().length).toBe(before)
    expect((await gateway(a, '', '_all_docs')).status).toBe(401)
  })
  it('keeps overlapping A/B streams and writes isolated, with native bodies and headers', async () => {
    const [{ cookie: ca }, { cookie: cb }] = await Promise.all([login(a), login(b)])
    fake.requests.length = 0
    const [streamA, streamB] = await Promise.all([
      gateway(a, ca, '_changes?feed=longpoll&since=0%2Fx'),
      gateway(b, cb, '_changes?feed=longpoll&since=0'),
    ])
    const readerA = streamA.body!.getReader(), readerB = streamB.body!.getReader()
    expect(new TextDecoder().decode((await readerA.read()).value)).toBe('\n')
    expect(new TextDecoder().decode((await readerB.read()).value)).toBe('\n')
    const [writeB, writeA] = await Promise.all([
      gateway(b, cb, 'quiz:alex', 'PUT', '{ "owner": "B", "type":"quiz" }'),
      gateway(a, ca, 'attempt:david', 'PUT', '{"owner":"A","type":"attempt"}'),
    ])
    expect(writeA.status).toBe(201); expect(writeB.status).toBe(201)
    expect(writeB.headers.get('etag')).toBe('"native-revision"')
    expect(writeB.headers.get('set-cookie')).toBe(null)
    expect(writeB.headers.get('access-control-allow-origin')).toBe(null)
    const data = await (await gateway(b, cb, '_all_docs?include_docs=true')).text()
    expect(data).toContain('quiz:alex'); expect(data).not.toContain('attempt:david')
    expect((await gateway(a, ca, 'quiz:alex')).status).toBe(404)
    const upstream = studyRequests()
    expect(upstream.find((r) => r.path.includes('since=0%2Fx'))?.path).toBe(`/${userDatabase(a.userId)}/_changes?feed=longpoll&since=0%2Fx`)
    expect(upstream.find((r) => r.method === 'PUT' && r.path.includes('quiz:alex'))).toMatchObject({
      path: `/${userDatabase(b.userId)}/quiz:alex`, body: '{ "owner": "B", "type":"quiz" }',
    })
    for (const request of upstream) {
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers['x-study-user']).toBeUndefined()
      expect(request.headers.authorization).toBe(couch.authorization)
    }
    expect(fake.streams.map((s) => s.database).sort()).toEqual([userDatabase(a.userId), userDatabase(b.userId)].sort())
    for (const stream of fake.streams) stream.response.end('{"results":[],"last_seq":1}')
    await readerA.cancel(); await readerB.cancel()
  })
  it('proxies PouchDB operations and checkpoint revisions without JSON rewriting', async () => {
    const cookie = await session(a)
    const operations = [
      ['_bulk_docs', 'POST', '{"docs":[{"_id":"quiz:one","value":1}]}'],
      ['_revs_diff', 'POST', '{"quiz:one":["1-test"]}'],
      ['_bulk_get', 'POST', '{"docs":[{"id":"quiz:one"}]}'],
      ['_local/checkpoint', 'PUT', '{"last_seq":1}'],
      ['_local/checkpoint', 'GET', undefined], ['quiz:one', 'GET', undefined],
      ['_changes?since=0', 'GET', undefined], ['_all_docs', 'POST', '{"keys":["quiz:one"]}'],
    ] as const
    for (const [path, method, body] of operations) {
      const response = await gateway(a, cookie, path, method, body)
      expect(response.ok, path).toBe(true)
      expect(studyRequests().at(-1)).toMatchObject({ path: `/${userDatabase(a.userId)}/${path}`, method, body: body ?? '' })
    }
  })
  it('rejects raw encoded traversal/admin paths and never creates a missing database', async () => {
    const cookie = await session(a)
    const before = studyRequests().length
    for (const path of ['../_all_dbs', '%2e%2e/_users', '%252e%252e/_users', '_security', '_design/evil']) {
      expect(await rawRequest('/couchdb/my/' + path, cookie)).toBeGreaterThanOrEqual(400)
    }
    expect(studyRequests().length).toBe(before)
    for (const method of ['PUT', 'DELETE']) expect((await gateway(a, cookie, '', method)).status).toBe(403)
    fake.databases.delete(userDatabase(a.userId))
    const missing = await gateway(a, cookie, '_all_docs')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'not_found', reason: 'Database does not exist.' })
    expect(fake.databases.has(userDatabase(a.userId))).toBe(false)
  })
})


it('keeps a partially provisioned account disabled until a successful resume', async () => {
  fake.faults.userSecurity = true
  await expect(provisionUser(couch, { login: 'charlie-test', displayName: 'Charlie', password: PASSWORD })).rejects.toThrow()
  const saved = fake.databases.get(AUTH_DATABASE)!.get('login:charlie-test')!
  expect(saved.enabled).toBe(false)
  expect(saved.provisioned).toBe(false)
  expect(saved.mustChangePassword).toBe(true)
  expect((await login({ ...a, login: 'charlie-test' })).response.status).toBe(401)
  fake.faults.userSecurity = false
  const resumed = await provisionUser(couch, { login: 'charlie-test', resume: true })
  expect(resumed.userId).toBe(saved.userId)
  expect(resumed.password).toEqual(saved.password)
  expect(resumed.mustChangePassword).toBe(true)
  expect(resumed.enabled).toBe(true)
})

it('streams request bodies before completion and cancels abandoned upstream feeds', async () => {
  const cookie = await session(a)
  let upload!: http.ClientRequest
  const result = new Promise<number>((resolve, reject) => {
    upload = http.request(base, { method: 'PUT', path: '/couchdb/my/quiz:stream', headers: {
      Cookie: cookie, 'X-Study-User': a.userId, Authorization: 'Basic browser-must-not-forward',
      'Content-Type': 'application/json',
    } }, (response) => { response.resume(); response.on('end', () => resolve(response.statusCode!)) })
    upload.on('error', reject)
  })
  upload.write('{"value":')
  await vi.waitFor(() => expect(fake.chunksSeen.some((c) => c.path.endsWith('/quiz:stream') && c.chunk === '{"value":')).toBe(true))
  upload.end('123}')
  expect(await result).toBe(201)
  expect(studyRequests().at(-1)?.headers.authorization).toBe(couch.authorization)
  const response = await gateway(a, cookie, '_changes?feed=longpoll')
  await response.body!.cancel()
  await vi.waitFor(() => expect(fake.streams.at(-1)?.response.destroyed).toBe(true))
})

it('supports 50 simultaneous authenticated user streams and isolated writes', async () => {
  const users = await Promise.all(Array.from({ length: 50 }, async (_, index) => {
    const user = { ...a, _id: `login:load-${index}`, _rev: undefined, login: `load-${index}`, userId: randomUUID() }
    await couch.put(AUTH_DATABASE, user._id, user)
    await secureDatabase(couch, userDatabase(user.userId))
    return { user, cookie: await session(user) }
  }))
  const streams = await Promise.all(users.map(({ user, cookie }) => gateway(user, cookie, '_changes?feed=longpoll')))
  expect(streams.every((r) => r.status === 200)).toBe(true)
  const writes = await Promise.all(users.map(({ user, cookie }) => gateway(user, cookie, 'quiz:load', 'PUT', JSON.stringify({ owner: user.userId }))))
  expect(writes.every((r) => r.status === 201)).toBe(true)
  await Promise.all(users.map(async ({ user, cookie }) => {
    const response = await gateway(user, cookie, 'quiz:load')
    expect(await response.json()).toMatchObject({ owner: user.userId })
  }))
  expect(new Set(fake.streams.map((s) => s.database)).size).toBe(50)
  await Promise.all(streams.map((r) => r.body!.cancel()))
})


it('serves the built app without exposing environment files or unknown API routes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'study-static-'))
  await mkdir(join(directory, 'assets'))
  await writeFile(join(directory, 'index.html'), '<main>Semantic Drill</main>')
  await writeFile(join(directory, 'assets', 'test.js'), 'export {}')
  const staticServer = createStudyServer(couch.config, { staticDirectory: directory })
  const url = await listen(staticServer)
  try {
    const page = await fetch(url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('Semantic Drill')
    const asset = await fetch(url + '/assets/test.js')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    for (const path of ['/.env.server', '/api/unknown', '/couchdb/', '/_all_dbs']) {
      expect((await fetch(url + path)).status).toBe(404)
    }
    expect((await fetch(url, { method: 'HEAD' })).status).toBe(200)
  } finally {
    await close(staticServer)
    await rm(directory, { recursive: true, force: true })
  }
})
