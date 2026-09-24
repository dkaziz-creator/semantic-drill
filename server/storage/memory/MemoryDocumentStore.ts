import { DomainError } from '../../domain/errors.js'
import type { Versioned } from '../../repositories/Versioned.js'
import type { DocumentStore, StoredDocument } from '../DocumentStore.js'
import { assertDatabaseName } from '../databaseNames.js'

export class MemoryDocumentStore implements DocumentStore {
  private readonly databases = new Map<string, Map<string, Versioned<StoredDocument<unknown>>>>()
  private revision = 0

  async provision(database: string): Promise<void> {
    assertDatabaseName(database)
    if (!this.databases.has(database)) this.databases.set(database, new Map())
  }

  private db(database: string) {
    assertDatabaseName(database)
    const db = this.databases.get(database)
    if (!db) throw new DomainError('STORAGE_ERROR', 'Database has not been provisioned')
    return db
  }

  async get<T>(database: string, id: string): Promise<Versioned<StoredDocument<T>> | undefined> {
    return structuredClone(this.db(database).get(id)) as Versioned<StoredDocument<T>> | undefined
  }

  async list<T>(database: string, prefix: string): Promise<Versioned<StoredDocument<T>>[]> {
    return [...this.db(database)].filter(([id]) => id.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)).map(([, doc]) => structuredClone(doc)) as Versioned<StoredDocument<T>>[]
  }

  async create<T>(database: string, id: string, document: StoredDocument<T>): Promise<void> {
    const db = this.db(database)
    if (db.has(id)) throw new DomainError('CONFLICT', 'Document already exists')
    db.set(id, { value: structuredClone(document), revision: String(++this.revision) })
  }

  async replace<T>(database: string, id: string, document: StoredDocument<T>, revision: string): Promise<void> {
    const db = this.db(database)
    if (db.get(id)?.revision !== revision) throw new DomainError('CONFLICT', 'Document revision changed')
    db.set(id, { value: structuredClone(document), revision: String(++this.revision) })
  }
}
