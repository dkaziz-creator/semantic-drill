import { describe, expect, it, vi } from 'vitest'
import { createBackend } from '../createBackend.js'
import { DomainError } from '../domain/errors.js'
import { user, alice } from '../test/fixtures.js'
import { FakeCouch } from '../test/FakeCouch.js'
import { CouchDbClient } from './couchdb/CouchDbClient.js'
import { databases } from './databaseNames.js'
import { MemoryDocumentStore } from './memory/MemoryDocumentStore.js'

describe.each(['memory', 'couch-http'])('%s identity reservations', adapter => {
  async function setup() {
    const store = adapter === 'memory' ? new MemoryDocumentStore()
      : new CouchDbClient({ url: 'http://couch.test:5984', username: 'backend', password: 'test-secret' }, new FakeCouch().fetch)
    const backend = createBackend(store)
    await backend.initialize()
    return { store, backend, repository: backend.repositories.users }
  }

  it('atomically prevents two logins from sharing a UUID', async () => {
    const { repository } = await setup()
    const results = await Promise.allSettled([
      repository.create(user(alice, 'first')), repository.create(user(alice, 'second')),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
    const first = await repository.getByLogin('first')
    const second = await repository.getByLogin('second')
    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect(await repository.getById(alice.userId)).toEqual(first ?? second)
  })

  it('hides partial identity creation and recovers with the same server-owned record', async () => {
    const { store, backend, repository } = await setup()
    const create = store.create.bind(store)
    vi.spyOn(store, 'create').mockImplementation(async (database, id, document) => {
      if (id.startsWith('login:')) throw new DomainError('STORAGE_ERROR', 'Injected identity failure')
      return create(database, id, document)
    })
    const record = user(alice, 'alice')
    await expect(repository.create(record)).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(await store.get(databases.users, `user:${alice.userId}`)).toBeDefined()
    expect(await repository.getById(alice.userId)).toBeUndefined()
    expect(await repository.getByLogin('alice')).toBeUndefined()
    await expect(backend.services.users.getCurrentUser(alice)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    vi.mocked(store.create).mockRestore()
    await repository.create(record)
    expect((await repository.getByLogin('alice'))?.value).toEqual(record)
    expect((await repository.getById(alice.userId))?.value).toEqual(record)
  })
})
