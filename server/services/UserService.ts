import { randomUUID } from 'node:crypto'
import { DomainError, requireCondition } from '../domain/errors.js'
import { normalizeLogin, publicUser } from '../domain/users.js'
import type { Principal, PublicUser, UserRecord, UserRole } from '../domain/users.js'
import { nonemptyString, onlyKeys } from '../domain/validation.js'
import type { UserRepository } from '../repositories/UserRepository.js'
import type { AuthorizationService } from './AuthorizationService.js'

export interface CreateUserInput { login: string; displayName: string; role?: UserRole }

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly authorization: AuthorizationService,
    private readonly now: () => number = Date.now,
  ) {}

  async createUser(principal: Principal, input: CreateUserInput): Promise<PublicUser> {
    await this.authorization.requireAdmin(principal)
    onlyKeys(input, ['login', 'displayName', 'role'])
    const login = normalizeLogin(input.login)
    nonemptyString(input.displayName)
    const role = input.role ?? 'student'
    requireCondition(role === 'admin' || role === 'student', 'Invalid role')
    const now = this.now()
    const user: UserRecord = {
      id: randomUUID(), login, displayName: input.displayName.trim(), role, status: 'active',
      auth: { type: 'unconfigured' }, leaderboard: { optIn: false }, createdAt: now, updatedAt: now,
    }
    await this.users.create(user)
    return publicUser(user)
  }

  async getCurrentUser(principal: Principal): Promise<PublicUser> {
    return publicUser(await this.authorization.requireActive(principal))
  }

  async disableUser(principal: Principal, targetUserId: string): Promise<PublicUser> {
    await this.authorization.requireAdmin(principal)
    const user = await this.users.getById(targetUserId)
    if (!user) throw new DomainError('NOT_FOUND', 'User not found')
    if (user.value.status === 'disabled') return publicUser(user.value)
    const disabled: UserRecord = { ...user.value, status: 'disabled', updatedAt: Math.max(this.now(), user.value.updatedAt) }
    await this.users.replace(disabled, user.revision)
    return publicUser(disabled)
  }
}
