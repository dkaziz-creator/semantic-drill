import { assertAttemptTransition } from '../../domain/attempts.js'
import type { Attempt } from '../../domain/attempts.js'
import { DomainError, requireCondition } from '../../domain/errors.js'
import { assertPrincipal } from '../../domain/users.js'
import type { Principal } from '../../domain/users.js'
import { assertUserId } from '../../domain/validation.js'
import type { AttemptRepository } from '../../repositories/AttemptRepository.js'
import type { DocumentStore } from '../DocumentStore.js'
import { userDatabaseName } from '../databaseNames.js'
import { document } from './helpers.js'

export class StoredAttemptRepository implements AttemptRepository {
  constructor(private readonly store: DocumentStore) {}

  private database(principal: Principal): string {
    assertPrincipal(principal)
    return userDatabaseName(principal.userId)
  }

  async create(principal: Principal, attempt: Attempt): Promise<void> {
    const database = this.database(principal)
    assertUserId(attempt.id)
    requireCondition(attempt.userId === principal.userId, 'Attempt owner must match principal')
    requireCondition(attempt.status === 'active' && attempt.result === undefined && attempt.completedAt === undefined, 'A new attempt must be active')
    await this.store.create(database, `attempt:${attempt.id}`, document('attempt', attempt))
  }

  async list(principal: Principal): Promise<Attempt[]> {
    return (await this.store.list<Attempt>(this.database(principal), 'attempt:'))
      .filter(doc => doc.value.type === 'attempt' && doc.value.value.userId === principal.userId)
      .map(doc => doc.value.value)
  }

  async get(principal: Principal, attemptId: string) {
    assertUserId(attemptId)
    const doc = await this.store.get<Attempt>(this.database(principal), `attempt:${attemptId}`)
    return doc?.value.type === 'attempt' && doc.value.value.userId === principal.userId
      ? { value: doc.value.value, revision: doc.revision } : undefined
  }

  async replace(principal: Principal, attempt: Attempt, expectedRevision: string): Promise<void> {
    requireCondition(attempt.userId === principal.userId, 'Attempt owner must match principal')
    const previous = await this.get(principal, attempt.id)
    if (!previous) throw new DomainError('NOT_FOUND', 'Attempt not found')
    if (previous.revision !== expectedRevision) throw new DomainError('CONFLICT', 'Attempt revision changed')
    assertAttemptTransition(previous.value, attempt)
    await this.store.replace(this.database(principal), `attempt:${attempt.id}`, document('attempt', attempt), expectedRevision)
  }
}
