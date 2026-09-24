import { DomainError, requireCondition } from '../../domain/errors.js'
import type { Versioned } from '../../repositories/Versioned.js'
import type { DocumentStore, StoredDocument } from '../DocumentStore.js'
import { assertDatabaseName } from '../databaseNames.js'

export interface CouchDbConfig {
  url: string
  username: string
  password: string
  timeoutMs?: number
}

type CouchDocument<T> = StoredDocument<T> & { _id: string; _rev: string }

/** Server-only fetch transport. Construction performs no network I/O. */
export class CouchDbClient implements DocumentStore {
  private readonly baseUrl: string
  private readonly authorization: string
  private readonly username: string
  private readonly timeoutMs: number

  constructor(config: CouchDbConfig, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(config.url)
    requireCondition(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash, 'Expected a server CouchDB URL without embedded credentials or query')
    requireCondition(typeof config.username === 'string' && config.username.length > 0 && !config.username.includes(':')
      && typeof config.password === 'string' && config.password.length > 0, 'CouchDB credentials are required')
    this.baseUrl = url.toString().replace(/\/$/, '')
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`
    this.username = config.username
    this.timeoutMs = config.timeoutMs ?? 10_000
    requireCondition(Number.isSafeInteger(this.timeoutMs) && this.timeoutMs > 0, 'Invalid CouchDB timeout')
  }

  private async request(database: string, path: string, method = 'GET', body?: unknown): Promise<Response> {
    assertDatabaseName(database)
    try {
      return await this.fetcher(`${this.baseUrl}/${encodeURIComponent(database)}${path}`, {
        method,
        headers: { Authorization: this.authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch {
      // Never forward fetch errors, server response bodies, URLs or credentials to callers.
      throw new DomainError('STORAGE_ERROR', 'CouchDB request failed')
    }
  }

  private check(response: Response): void {
    if (response.status === 409) throw new DomainError('CONFLICT', 'Document revision conflict')
    if (!response.ok) throw new DomainError('STORAGE_ERROR', `CouchDB returned HTTP ${response.status}`)
  }

  private unwrap<T>(doc: CouchDocument<T>): Versioned<StoredDocument<T>> {
    if (doc.schemaVersion !== 2 || typeof doc._rev !== 'string') throw new DomainError('STORAGE_ERROR', 'Invalid v2 document')
    return {
      revision: doc._rev,
      value: { schemaVersion: 2, type: doc.type, value: doc.value,
        ...(doc.contentHash === undefined ? {} : { contentHash: doc.contentHash }) },
    }
  }

  async provision(database: string): Promise<void> {
    const created = await this.request(database, '', 'PUT')
    if (created.status !== 412) this.check(created)
    // Explicit membership closes anonymous access, including on an existing empty-security DB.
    const secured = await this.request(database, '/_security', 'PUT', {
      admins: { names: [], roles: ['_admin'] },
      members: { names: [this.username], roles: ['_admin'] },
    })
    this.check(secured)
  }

  async get<T>(database: string, id: string): Promise<Versioned<StoredDocument<T>> | undefined> {
    const response = await this.request(database, `/${encodeURIComponent(id)}`)
    if (response.status === 404) return undefined
    this.check(response)
    return this.unwrap(await response.json() as CouchDocument<T>)
  }

  async list<T>(database: string, prefix: string): Promise<Versioned<StoredDocument<T>>[]> {
    const query = new URLSearchParams({ include_docs: 'true', startkey: JSON.stringify(prefix), endkey: JSON.stringify(`${prefix}\ufff0`) })
    const response = await this.request(database, `/_all_docs?${query}`)
    this.check(response)
    const result = await response.json() as { rows: { doc?: CouchDocument<T> }[] }
    return result.rows.flatMap(row => row.doc ? [this.unwrap(row.doc)] : [])
  }

  async create<T>(database: string, id: string, document: StoredDocument<T>): Promise<void> {
    const response = await this.request(database, `/${encodeURIComponent(id)}`, 'PUT', { ...document, _id: id })
    this.check(response)
  }

  async replace<T>(database: string, id: string, document: StoredDocument<T>, revision: string): Promise<void> {
    requireCondition(typeof revision === 'string' && revision.length > 0, 'Revision is required')
    const response = await this.request(database, `/${encodeURIComponent(id)}`, 'PUT', { ...document, _id: id, _rev: revision })
    this.check(response)
  }
}
