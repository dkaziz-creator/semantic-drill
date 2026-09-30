import { scryptSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../auth/passwords.js'
import { gatewayPath } from '../couch/gateway.js'
import { userDatabase } from '../auth/users.js'
import { loadConfig } from '../config.js'
import { LoginLimiter } from '../auth/rateLimiter.js'
import { sessionCookie } from '../http/cookies.js'

const A = '550e8400-e29b-41d4-a716-446655440000'
const password = 'a test password with spaces'

describe('password derivation', () => {
  it('salts independently, stores no plaintext, verifies correct/incorrect passwords', async () => {
    const a = await hashPassword(password)
    const b = await hashPassword(password)
    expect(a.hash).not.toBe(password)
    expect(a.salt).not.toBe(b.salt)
    expect(a.hash).not.toBe(b.hash)
    expect(await verifyPassword(password, a)).toBe(true)
    expect(await verifyPassword('a different password', a)).toBe(false)
  })
  it('uses the stored bounded scrypt parameters', async () => {
    const record = await hashPassword(password)
    record.cost = { N: 16384, r: 8, p: 2 }
    record.hash = scryptSync(password, Buffer.from(record.salt, 'hex'), 64, { ...record.cost, maxmem: 128 * 1024 * 1024 }).toString('hex')
    expect(await verifyPassword(password, record)).toBe(true)
  })
  it.each([null, {}, { algorithm: 'scrypt', hash: 'z', salt: 'bad' },
    { algorithm: 'scrypt', hash: '00'.repeat(64), salt: '00'.repeat(32), cost: { N: 2 ** 30, r: 8, p: 1 } },
  ])('rejects malformed stored records safely: %j', async (record) => {
    expect(await verifyPassword(password, record)).toBe(false)
  })
  it('bounds password size', async () => {
    await expect(hashPassword('short')).rejects.toThrow()
    await expect(hashPassword('x'.repeat(1025))).rejects.toThrow()
  })
})

describe('gateway paths', () => {
  it('derives the DB solely from a canonical UUID and preserves raw queries', () => {
    expect(gatewayPath('/couchdb/my/_changes?since=1%2Fg&x=a+b', 'GET', A))
      .toBe(`/${userDatabase(A)}/_changes?since=1%2Fg&x=a+b`)
    expect(() => userDatabase('../other')).toThrow()
    expect(() => userDatabase(A.toUpperCase())).toThrow()
  })
  it.each([
    '/couchdb/my/../_all_dbs', '/couchdb/my/%2e%2e/_users', '/couchdb/my/%252e%252e/_users',
    '/couchdb/my/%2e%2e%2f_users', '/couchdb/my/%5c..%5c_users', '/couchdb/my//_all_dbs',
    '/couchdb/my/_all_dbs', '/couchdb/my/_security', '/couchdb/my/_design/evil', '/couchdb/my/_purge',
    '/couchdb/my/_replicate', '/couchdb/my/_users', '/couchdb/my/_replication', '/couchdb/my/_node/x',
    '/couchdb/my/http://example.com/db', 'http://example.com/couchdb/my/quiz',
    '/couchdb/my/%', '/couchdb/my/a%00b', '/couchdb/my/quiz%3f/../../_users', '/couchdb/another-db/doc',
  ])('rejects escape/admin target %s', (path) => { expect(() => gatewayPath(path, 'GET', A)).toThrow() })
  it.each(['PUT', 'DELETE', 'POST'])('blocks %s database root', (method) => {
    expect(() => gatewayPath('/couchdb/my/', method, A)).toThrow()
  })
  it('a database-looking document ID is still inside the session-selected DB', () => {
    expect(gatewayPath('/couchdb/my/semantic-drill-user-other', 'GET', A)).toBe(`/${userDatabase(A)}/semantic-drill-user-other`)
  })
})

describe('configuration, cookie and limiter boundaries', () => {
  const env = { STUDY_PUBLIC_ORIGIN: 'https://study.example', COUCHDB_INTERNAL_URL: 'http://127.0.0.1:5984', COUCHDB_USERNAME: 'internal', COUCHDB_PASSWORD: 'secret' }
  it('requires explicit development mode for insecure cookies and HTTP', () => {
    expect(loadConfig(env).cookieSecure).toBe(true)
    expect(() => loadConfig({ ...env, SESSION_COOKIE_SECURE: 'false' })).toThrow('Production requires')
    expect(() => loadConfig({ ...env, STUDY_PUBLIC_ORIGIN: 'http://study.example' })).toThrow()
    expect(loadConfig({ ...env, NODE_ENV: 'development', SESSION_COOKIE_SECURE: 'false' }).cookieSecure).toBe(false)
    expect(() => loadConfig({ ...env, COUCHDB_INTERNAL_URL: 'http://private:secret@localhost' })).toThrow('Invalid configuration')
    expect(() => loadConfig({})).toThrow()
  })
  it('does not accept ambiguous session cookies', () => {
    expect(sessionCookie('other=1; study_session=abc')).toBe('abc')
    expect(sessionCookie('study_session=a; study_session=b')).toBe('')
  })
  it('limits pairs and IPs, bounds memory and expires stale entries', () => {
    const limiter = new LoginLimiter(3, 100)
    for (let n = 0; n < 10; n++) expect(limiter.take('a', 'david', 0)).toBe(true)
    expect(limiter.take('a', 'david', 0)).toBe(false)
    expect(limiter.take('b', 'alex', 0)).toBe(false)
    expect(limiter.size).toBeLessThanOrEqual(3)
    expect(limiter.take('b', 'alex', 101)).toBe(true)
    limiter.success('b', 'alex')
    expect(limiter.size).toBe(1)
    const byIp = new LoginLimiter()
    for (let n = 0; n < 100; n++) expect(byIp.take('a', `user${n}`, 0)).toBe(true)
    expect(byIp.take('a', 'another', 0)).toBe(false)
  })
})
