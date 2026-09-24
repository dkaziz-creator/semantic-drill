import type { Versioned } from '../repositories/Versioned.js'

export interface StoredDocument<T> {
  schemaVersion: 2
  type: 'user' | 'login-claim' | 'quiz' | 'answer-key' | 'attempt' | 'user-quiz' | 'user-answer-key'
  value: T
  /** Binds an immutable key to content across the two publication writes. */
  contentHash?: string
}

/** All mutations are create-only or compare-and-swap; there is no blind upsert. */
export interface DocumentStore {
  provision(database: string): Promise<void>
  get<T>(database: string, id: string): Promise<Versioned<StoredDocument<T>> | undefined>
  list<T>(database: string, prefix: string): Promise<Versioned<StoredDocument<T>>[]>
  create<T>(database: string, id: string, document: StoredDocument<T>): Promise<void>
  replace<T>(database: string, id: string, document: StoredDocument<T>, revision: string): Promise<void>
}
