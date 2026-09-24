import { describe, expect, it, vi } from 'vitest'
import { createBackend } from '../../createBackend.js'
import { admin, alice, publishInput, user } from '../../test/fixtures.js'
import { FakeCouch } from '../../test/FakeCouch.js'
import { databases, userDatabaseName } from '../databaseNames.js'
import { CouchDbClient } from './CouchDbClient.js'

const config = { url: 'http://couch.test:5984', username: 'backend', password: 'test-secret' }

describe('CouchDB transport boundaries', () => {
  it('has no startup I/O, provisions only v2 databases and secures each against anonymous access', async () => {
    const fake = new FakeCouch()
    const client = new CouchDbClient(config, fake.fetch)
    const backend = createBackend(client)
    expect(fake.requests).toEqual([])
    await backend.initialize()
    await backend.initialize() // 412 means existing DB, but membership is still enforced.
    await backend.repositories.users.create(user(admin, 'admin'))
    await backend.services.users.createUser(admin, { login: 'david', displayName: 'David' })
    await backend.services.quizzes.publishQuiz(admin, publishInput())
    for (const name of fake.databases.keys()) {
      expect(name).toMatch(/^semantic-drill-v2-/)
      expect(fake.security.get(name)).toEqual({
        admins: { names: [], roles: ['_admin'] }, members: { names: ['backend'], roles: ['_admin'] },
      })
    }
    for (const { url, init } of fake.requests) {
      expect(url.pathname).not.toContain('semantic-drill-learning')
      expect(url.username).toBe('')
      expect(url.password).toBe('')
      expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${Buffer.from('backend:test-secret').toString('base64')}`)
      expect(init.redirect).toBe('error')
      expect(init.signal).toBeInstanceOf(AbortSignal)
    }
    const catalog = [...fake.databases.get(databases.catalog)!.values()]
    expect(JSON.stringify(catalog)).not.toContain('correctAnswers')
    expect(JSON.stringify(catalog)).not.toContain('Secret explanation')
    expect(JSON.stringify([...fake.databases.get(databases.answers)!.values()])).toContain('correctAnswers')
  })

  it('does not create a user if database security provisioning fails', async () => {
    const fake = new FakeCouch()
    const client = new CouchDbClient(config, fake.fetch)
    const backend = createBackend(client)
    await backend.initialize()
    fake.failNext = { database: userDatabaseName(alice.userId), id: '_security', status: 403 }
    await expect(backend.repositories.users.create(user(alice, 'alice'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(await backend.repositories.users.getById(alice.userId)).toBeUndefined()
    // A retry re-applies security to the already created DB before storing the account.
    await backend.repositories.users.create(user(alice, 'alice'))
    expect(fake.security.has(userDatabaseName(alice.userId))).toBe(true)
  })

  it('uses revisions for compare-and-swap and never silently overwrites', async () => {
    const fake = new FakeCouch()
    const client = new CouchDbClient(config, fake.fetch)
    await client.provision(databases.users)
    const doc = { schemaVersion: 2, type: 'user', value: user(alice, 'alice') } as const
    await client.create(databases.users, 'user:alice', doc)
    const first = (await client.get(databases.users, 'user:alice'))!
    await client.replace(databases.users, 'user:alice', doc, first.revision)
    await expect(client.replace(databases.users, 'user:alice', doc, first.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(client.create(databases.users, 'user:alice', doc)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await client.get(databases.users, 'user:missing')).toBeUndefined()
    expect(JSON.stringify(first)).not.toContain('_rev')
  })

  it('encodes document IDs and prefix range queries', async () => {
    const fake = new FakeCouch()
    const client = new CouchDbClient(config, fake.fetch)
    await client.provision(databases.catalog)
    await client.get(databases.catalog, 'quiz:a/b ?#&:v1')
    const request = fake.requests.at(-1)!.url
    expect(request.pathname).toContain('quiz%3Aa%2Fb%20%3F%23%26%3Av1')
    expect(request.search).toBe('')
    await client.list(databases.catalog, 'quiz:')
    const query = fake.requests.at(-1)!.url.searchParams
    expect(JSON.parse(query.get('startkey')!)).toBe('quiz:')
    expect(JSON.parse(query.get('endkey')!)).toBe('quiz:\ufff0')
    expect(query.get('include_docs')).toBe('true')
  })

  it('rejects any v1 or arbitrary database before network access', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const client = new CouchDbClient(config, fetcher)
    for (const name of ['semantic-drill-learning', '../_users', 'semantic-drill-v2-user-admin']) {
      await expect(client.provision(name)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      await expect(client.get(name, 'attempt:x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([401, 403, 500])('treats HTTP %i as a storage error without exposing the body', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('test-secret', { status }))
    const client = new CouchDbClient(config, fetcher)
    await expect(client.get(databases.users, 'user:alice')).rejects.toMatchObject({
      code: 'STORAGE_ERROR', message: `CouchDB returned HTTP ${status}`,
    })
  })

  it('sanitizes network/timeout failures and rejects embedded credentials', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('test-secret'))
    const client = new CouchDbClient(config, fetcher)
    await expect(client.get(databases.users, 'user:alice')).rejects.toMatchObject({ code: 'STORAGE_ERROR', message: 'CouchDB request failed' })
    expect(() => new CouchDbClient({ ...config, url: 'http://name:secret@couch.test' })).toThrow()
  })
})
