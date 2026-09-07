import PouchDB from 'pouchdb-browser'
import type { QuizAttempt, QuizSession, SavedQuiz } from '../types/quiz'

export type LearningValue =
  | { type: 'quiz'; value: SavedQuiz }
  | { type: 'attempt'; value: QuizAttempt }
  | { type: 'session'; value: QuizSession }

export type LearningDocument = LearningValue & { _id: string; order: number }
export type StoredLearningDocument = { type?: unknown; value?: unknown; order?: number }
export type LearningDatabase = PouchDB.Database<StoredLearningDocument>
export type StorageChange = LearningValue['type'] | 'status'

// A _local document is deliberately excluded from CouchDB replication: every
// browser must import its own legacy data, even when other devices already did.
const MIGRATION_ID = '_local/learning-localstorage-v1'

export function openLearningDatabase(): LearningDatabase {
  return new PouchDB<StoredLearningDocument>('semantic-drill-learning', {
    adapter: 'idb',
    auto_compaction: true,
  })
}

function hasStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status
}

type PendingWrite = { document: LearningDocument | null; insertOnly: boolean }

/** Synchronous snapshots backed by serialized, per-document IndexedDB writes. */
export class LearningStore {
  private documents = new Map<string, LearningDocument>()
  private pending = new Map<string, PendingWrite>()
  private writing: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private changes?: PouchDB.Core.Changes<StoredLearningDocument>
  private replication?: PouchDB.Replication.Sync<StoredLearningDocument>
  private remote?: LearningDatabase
  private refreshing: Promise<void> = Promise.resolve()
  private lastOrder = 0
  private closed = false
  available = false

  constructor(
    readonly database: LearningDatabase,
    private normalize: (document: PouchDB.Core.ExistingDocument<StoredLearningDocument>) => LearningDocument | null,
    private notify: (type: StorageChange) => void,
  ) {}

  async initialize(readLegacy: () => LearningDocument[] | null): Promise<void> {
    try {
      await this.database.get(MIGRATION_ID)
    } catch (error) {
      if (!hasStatus(error, 404)) throw error
      const legacy = readLegacy()
      // If localStorage is blocked, use IndexedDB but try the import again on
      // a later startup. Never mark unreadable legacy data as migrated.
      if (legacy !== null) {
        for (const document of legacy) await this.persist(document._id, { document, insertOnly: true }, true)
        try {
          await this.database.put({ _id: MIGRATION_ID })
        } catch (error) {
          if (!hasStatus(error, 409)) throw error // another tab completed the same import
        }
      }
    }

    // Capture a sequence BEFORE the snapshot, then replay from it. Changes
    // made by another tab while allDocs runs cannot fall into a startup gap.
    const info = await this.database.info()
    const snapshot = await this.database.allDocs({ include_docs: true })
    for (const row of snapshot.rows) {
      if (row.doc) this.accept(row.id, row.doc)
    }
    this.changes = this.database.changes({ since: info.update_seq, live: true, include_docs: true })
      .on('change', (change) => {
        // Read the current winner rather than replaying a possibly stale echo
        // of our own write. Pending local changes always win in memory.
        this.refreshing = this.refreshing.then(async () => {
          if (this.closed || this.pending.has(change.id)) return
          let document: PouchDB.Core.ExistingDocument<StoredLearningDocument> | undefined
          try {
            document = await this.database.get(change.id)
          } catch (error) {
            if (!hasStatus(error, 404)) throw error
          }
          if (!this.closed && !this.pending.has(change.id)) this.accept(change.id, document)
        }).catch(() => this.setAvailable(false))
      })
      .on('error', () => this.setAvailable(false))
    this.setAvailable(true)
  }

  private accept(id: string, raw?: PouchDB.Core.ExistingDocument<StoredLearningDocument>): void {
    const previous = this.documents.get(id)
    const document = raw ? this.normalize(raw) : null
    if (document) {
      this.documents.set(id, document)
      this.lastOrder = Math.max(this.lastOrder, document.order)
    } else {
      this.documents.delete(id)
    }
    if (JSON.stringify(previous) !== JSON.stringify(document ?? undefined)) {
      const type = document?.type ?? previous?.type
      if (type) this.notify(type)
    }
  }

  list(type: LearningValue['type']): LearningDocument[] {
    return structuredClone([...this.documents.values()].filter((doc) => doc.type === type).sort((a, b) =>
      a.order - b.order || a._id.localeCompare(b._id),
    ))
  }

  get(id: string): LearningDocument | undefined {
    const document = this.documents.get(id)
    return document ? structuredClone(document) : undefined
  }

  set(id: string, value: LearningValue, insertOnly = false): void {
    if (insertOnly && this.documents.has(id)) return
    const order = this.documents.get(id)?.order ?? Math.max(Date.now(), this.lastOrder + 1)
    this.lastOrder = Math.max(this.lastOrder, order)
    const document = structuredClone({ ...value, _id: id, order })
    this.documents.set(id, document)
    this.enqueue(id, { document, insertOnly })
  }

  remove(id: string): void {
    this.documents.delete(id)
    this.enqueue(id, { document: null, insertOnly: false })
  }

  private enqueue(id: string, write: PendingWrite): void {
    this.pending.set(id, write)
    // flush catches/report failures, retains pending writes and retries. The
    // synchronous caller never receives an unhandled promise rejection.
    void this.flush().catch(() => undefined)
  }

  private setAvailable(value: boolean): void {
    if (this.available === value) return
    this.available = value
    this.notify('status')
  }

  /** Drain local writes; useful for controlled shutdowns and persistence tests. */
  async flush(): Promise<void> {
    if (this.writing) return this.writing
    clearTimeout(this.retryTimer)
    this.writing = (async () => {
      while (this.pending.size) {
        for (const [id, write] of this.pending) {
          const existing = await this.persist(id, write)
          if (this.pending.get(id) === write) {
            this.pending.delete(id)
            // An immutable attempt may already exist in another tab/device.
            if (existing) this.accept(id, existing)
          }
        }
      }
      this.setAvailable(true)
    })()
    try {
      await this.writing
    } catch (error) {
      this.setAvailable(false)
      if (!this.closed) {
        this.retryTimer = setTimeout(() => { void this.flush().catch(() => undefined) }, 2000)
      }
      throw error
    } finally {
      this.writing = null
    }
  }

  private async persist(id: string, write: PendingWrite, skipDeleted = false) {
    for (let tries = 0; tries < 5; tries++) {
      // allDocs exposes tombstone revisions too, unlike get(). This lets a
      // session be saved again after clearing it without a permanent conflict.
      const result = await this.database.allDocs({ keys: [id], include_docs: true })
      const row = result.rows[0]
      const existing = 'value' in row ? row : undefined
      if (write.insertOnly && existing && (skipDeleted || !existing.value.deleted)) return existing.doc
      if (!write.document && (!existing || existing.value.deleted)) return
      try {
        await this.database.put(write.document
          ? { ...write.document, _rev: existing?.value.rev }
          : { _id: id, _rev: existing?.value.rev, _deleted: true })
        return
      } catch (error) {
        if (!hasStatus(error, 409) || tries === 4) throw error
      }
    }
  }

  startSync(remoteUrl?: string): void {
    if (!remoteUrl?.trim()) return
    try {
      const url = new URL(remoteUrl.trim(), typeof location === 'undefined' ? undefined : location.href)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Use a CouchDB database URL without credentials, query parameters or fragments.')
      }
      this.remote = new PouchDB<StoredLearningDocument>(url.href, { skip_setup: true })
      this.replication = this.database.sync(this.remote, { live: true, retry: true })
        .on('error', () => console.warn('Learning-data sync stopped; local storage remains available.'))
        .on('denied', () => console.warn('The remote database denied a learning-data sync operation.'))
    } catch {
      // Do not log the URL or raw transport errors: a misconfigured URL may
      // contain credentials. Optional sync must never prevent local startup.
      console.warn('Learning-data sync could not start. Check VITE_COUCHDB_URL; local storage remains available.')
    }
  }

  async close(): Promise<void> {
    this.closed = true
    clearTimeout(this.retryTimer)
    this.replication?.cancel()
    this.changes?.cancel()
    await this.refreshing
    try {
      await this.flush()
    } finally {
      await this.database.close()
      await this.remote?.close()
    }
  }
}
