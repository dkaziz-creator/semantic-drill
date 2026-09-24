import type { UserRecord } from '../domain/users.js'
import type { Versioned } from './Versioned.js'

/** Trusted identity storage. HTTP callers must go through UserService. */
export interface UserRepository {
  create(user: UserRecord): Promise<void>
  getById(userId: string): Promise<Versioned<UserRecord> | undefined>
  getByLogin(login: string): Promise<Versioned<UserRecord> | undefined>
  replace(user: UserRecord, expectedRevision: string): Promise<void>
}
