import { DomainError } from '../domain/errors.js'
import { assertPrincipal } from '../domain/users.js'
import type { Principal, UserRecord } from '../domain/users.js'
import type { UserRepository } from '../repositories/UserRepository.js'

export class AuthorizationService {
  constructor(private readonly users: UserRepository) {}

  async requireActive(principal: Principal): Promise<UserRecord> {
    assertPrincipal(principal)
    const user = await this.users.getById(principal.userId)
    if (!user || user.value.status !== 'active' || user.value.role !== principal.role) {
      throw new DomainError('FORBIDDEN', 'An active server-authenticated principal is required')
    }
    return user.value
  }

  async requireAdmin(principal: Principal): Promise<void> {
    const user = await this.requireActive(principal)
    if (user.role !== 'admin') throw new DomainError('FORBIDDEN', 'Admin role is required')
  }
}
