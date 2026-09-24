import type { Attempt } from '../domain/attempts.js'
import type { Principal } from '../domain/users.js'
import type { Versioned } from './Versioned.js'

export interface AttemptRepository {
  create(principal: Principal, attempt: Attempt): Promise<void>
  list(principal: Principal): Promise<Attempt[]>
  get(principal: Principal, attemptId: string): Promise<Versioned<Attempt> | undefined>
  replace(principal: Principal, attempt: Attempt, expectedRevision: string): Promise<void>
}
