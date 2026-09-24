import { isDeepStrictEqual } from 'node:util'
import { DomainError, requireCondition } from '../../domain/errors.js'
import { normalizeLogin, validateUser } from '../../domain/users.js'
import type { UserRecord } from '../../domain/users.js'
import { assertUserId } from '../../domain/validation.js'
import type { UserRepository } from '../../repositories/UserRepository.js'
import type { DocumentStore } from '../DocumentStore.js'
import { databases, userDatabaseName } from '../databaseNames.js'
import { document } from './helpers.js'

interface LoginClaim { login: string; userId: string }

export class StoredUserRepository implements UserRepository {
  constructor(private readonly store: DocumentStore) {}

  async create(user: UserRecord): Promise<void> {
    validateUser(user)
    await this.store.provision(userDatabaseName(user.id))
    // Reserve UUID first. A user is visible only after a matching login claim exists.
    // Both keys are create-only, so concurrent requests cannot alias UUIDs or logins.
    try {
      await this.store.create(databases.users, `user:${user.id}`, document('user', user))
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'CONFLICT') throw error
      const existing = await this.store.get<UserRecord>(databases.users, `user:${user.id}`)
      if (existing?.value.type !== 'user' || !isDeepStrictEqual(existing.value.value, user)) {
        throw new DomainError('CONFLICT', 'User UUID is already reserved')
      }
    }
    // If this write fails, the pending UUID record stays inaccessible to services.
    // Retrying with the same UserRecord can safely finish the reservation.
    await this.store.create(databases.users, `login:${user.login}`,
      document<LoginClaim>('login-claim', { login: user.login, userId: user.id }))
  }

  async getById(userId: string) {
    assertUserId(userId)
    const found = await this.store.get<UserRecord>(databases.users, `user:${userId}`)
    if (found?.value.type !== 'user' || found.value.value.id !== userId) return undefined
    const claim = await this.store.get<LoginClaim>(databases.users, `login:${found.value.value.login}`)
    return claim?.value.type === 'login-claim' && claim.value.value.userId === userId
      && claim.value.value.login === found.value.value.login
      ? { value: found.value.value, revision: found.revision } : undefined
  }

  async getByLogin(login: string) {
    const normalized = normalizeLogin(login)
    const claim = await this.store.get<LoginClaim>(databases.users, `login:${normalized}`)
    if (claim?.value.type !== 'login-claim' || claim.value.value.login !== normalized) return undefined
    const found = await this.getById(claim.value.value.userId)
    return found?.value.login === normalized ? found : undefined
  }

  async replace(user: UserRecord, expectedRevision: string): Promise<void> {
    validateUser(user)
    const previous = await this.getById(user.id)
    if (!previous) throw new DomainError('NOT_FOUND', 'User not found')
    requireCondition(previous.value.login === user.login && previous.value.createdAt === user.createdAt,
      'User identity is immutable')
    await this.store.replace(databases.users, `user:${user.id}`, document('user', user), expectedRevision)
  }
}
