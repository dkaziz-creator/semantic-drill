import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AUTH_DATABASE } from '../config.js'
import { createStudyServer } from '../app.js'
import { CouchClient } from '../couch/client.js'
import { provisionUser } from '../couch/provisioning.js'
import { userDatabase, type User } from '../auth/users.js'
import { sessionId } from '../auth/sessions.js'
import { close, listen, testConfig } from './helpers.js'

// Explicit opt-in, disposable instance only. No default production URL/credentials.
describe.skipIf(process.env.STUDY_COUCHDB_INTEGRATION !== '1')('real CouchDB gateway contract', () => {
  let couch: CouchClient
  let server: Server | undefined
  let base: string
  const users: User[] = []
  const cookies: string[] = []
  const password = 'integration-only-password-' + randomUUID()

  beforeAll(async () => {
    if (!process.env.COUCHDB_TEST_URL || !process.env.COUCHDB_TEST_USERNAME || !process.env.COUCHDB_TEST_PASSWORD) {
      throw new Error('Set COUCHDB_TEST_URL, COUCHDB_TEST_USERNAME and COUCHDB_TEST_PASSWORD for a disposable CouchDB.')
    }
    const config = { ...testConfig(process.env.COUCHDB_TEST_URL),
      couchUsername: process.env.COUCHDB_TEST_USERNAME, couchPassword: process.env.COUCHDB_TEST_PASSWORD }
    couch = new CouchClient(config)
    for (const displayName of ['David', 'Alex']) users.push(await provisionUser(couch, {
      login: `integration-${randomUUID()}`, displayName, password,
    }))
    server = createStudyServer(config)
    base = await listen(server)
    for (const user of users) {
      const response = await fetch(base + '/api/auth/login', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: user.login, password }) })
      expect(response.status).toBe(200)
      cookies.push(response.headers.get('set-cookie')!.split(';')[0]!)
    }
  })

  afterAll(async () => {
    if (server) await close(server)
    // Clean only the UUID DBs and auth records created by this run; never drop auth DB.
    for (const user of users) await couch.request('DELETE', `/${userDatabase(user.userId)}`)
    for (const id of [...users.map((u) => u._id), ...cookies.map((c) => sessionId(c.slice('study_session='.length))!)]) {
      const doc = await couch.get<{ _rev: string }>(AUTH_DATABASE, id)
      if (doc) await couch.request('DELETE', `/${AUTH_DATABASE}/${encodeURIComponent(id)}?rev=${encodeURIComponent(doc._rev)}`)
    }
  })

  function gateway(index: number, path: string, method = 'GET', body?: unknown) {
    return fetch(base + '/couchdb/my/' + path, { method,
      headers: { Cookie: cookies[index]!, 'X-Study-User': users[index]!.userId, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) })
  }

  it('runs concurrent A/B long polls, native replication operations and private security', async () => {
    // Fresh databases have no changes; two outstanding polls overlap both writes.
    const polls = [0, 1].map((i) => gateway(i, '_changes?feed=longpoll&since=0&timeout=10000'))
    const writes = await Promise.all([gateway(0, 'attempt:david', 'PUT', { owner: 'A' }),
      gateway(1, 'quiz:alex', 'PUT', { owner: 'B' })])
    for (const response of writes) expect(response.status).toBe(201)
    const changes = await Promise.all(polls.map(async (p) => (await p).json()))
    expect(JSON.stringify(changes[0])).toContain('attempt:david')
    expect(JSON.stringify(changes[0])).not.toContain('quiz:alex')
    expect(JSON.stringify(changes[1])).toContain('quiz:alex')
    expect((await gateway(0, 'quiz:alex')).status).toBe(404)
    expect((await gateway(1, 'attempt:david')).status).toBe(404)

    const bulk = await gateway(0, '_bulk_docs', 'POST', { docs: [{ _id: 'quiz:shared', owner: 'A' }] })
    expect(bulk.status).toBe(201)
    const [created] = await bulk.json() as { rev: string }[]
    const diff = await gateway(0, '_revs_diff', 'POST', { 'quiz:shared': [created!.rev, '1-ffffffffffffffffffffffffffffffff'] })
    expect(await diff.json()).toEqual({ 'quiz:shared': { missing: ['1-ffffffffffffffffffffffffffffffff'] } })
    const get = await gateway(0, '_bulk_get', 'POST', { docs: [{ id: 'quiz:shared', rev: created!.rev }] })
    expect(get.ok).toBe(true)
    expect(JSON.stringify(await get.json())).toContain('quiz:shared')
    const putCheckpoint = await gateway(0, '_local/checkpoint', 'PUT', { last_seq: 1 })
    expect(putCheckpoint.status).toBe(201)
    const checkpoint = await (await gateway(0, '_local/checkpoint')).json() as { _rev: string }
    expect((await gateway(0, '_local/checkpoint', 'PUT', { _rev: checkpoint._rev, last_seq: 2 })).status).toBe(201)
    expect(await (await gateway(0, '_all_docs?include_docs=true')).text()).toContain('quiz:shared')
    expect(await (await gateway(1, '_all_docs?include_docs=true')).text()).not.toContain('quiz:shared')

    const mismatch = await fetch(base + '/couchdb/my/_all_docs', {
      headers: { Cookie: cookies[0]!, 'X-Study-User': users[1]!.userId },
    })
    expect(mismatch.status).toBe(403)
    for (const database of [AUTH_DATABASE, ...users.map((u) => userDatabase(u.userId))]) {
      expect([401, 403]).toContain((await fetch(couch.config.couchUrl + '/' + database + '/_all_docs')).status)
    }
  })
  it('replicates with the real PouchDB client and restores A on another local database', async () => {
    const idb = await import('fake-indexeddb')
    Object.assign(globalThis, { indexedDB: idb.indexedDB, IDBKeyRange: idb.IDBKeyRange })
    Object.defineProperty(globalThis, 'self', { value: globalThis, configurable: true })
    const PouchDB = (await import('pouchdb-browser')).default
    const locals = [0, 1, 2].map(() => new PouchDB(`integration-${randomUUID()}`, { adapter: 'idb' }))
    const remotes = [0, 1].map((index) => new PouchDB(base + '/couchdb/my/', {
      skip_setup: true,
      fetch: (url, options) => {
        const headers = new Headers(options?.headers)
        headers.set('Cookie', cookies[index]!)
        headers.set('X-Study-User', users[index]!.userId)
        return fetch(url, { ...options, headers })
      },
    }))
    try {
      await locals[0]!.put({ _id: 'attempt:pouch-a', owner: 'A' })
      await locals[1]!.put({ _id: 'quiz:pouch-b', owner: 'B' })
      await Promise.all([locals[0]!.sync(remotes[0]!), locals[1]!.sync(remotes[1]!)])
      await expect(locals[0]!.get('quiz:pouch-b')).rejects.toMatchObject({ status: 404 })
      await expect(locals[1]!.get('attempt:pouch-a')).rejects.toMatchObject({ status: 404 })
      await locals[2]!.replicate.from(remotes[0]!)
      expect(await locals[2]!.get('attempt:pouch-a')).toMatchObject({ owner: 'A' })
      await expect(locals[2]!.get('quiz:pouch-b')).rejects.toMatchObject({ status: 404 })
    } finally {
      await Promise.all(locals.map((db) => db.destroy()))
      await Promise.all(remotes.map((db) => db.close()))
    }
  })

})
