export type ErrorCode = 'INVALID_INPUT' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT'
  | 'INVALID_STATE' | 'FEATURE_DISABLED' | 'NOT_IMPLEMENTED' | 'STORAGE_ERROR'

export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message)
    this.name = 'DomainError'
  }
}

export function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DomainError('INVALID_INPUT', message)
}
