export interface AuthenticatedUser {
  /** Stable internal UUID assigned by the trusted server, never a login name. */
  id: string
  displayName?: string
}

/** Accept UUID versions 1–8, normalize case, and reject nil/non-RFC namespaces. */
export function canonicalUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('A valid internal user UUID is required.')
  }
  return value.toLowerCase()
}

export function userScopedKey(baseKey: string, userId: string): string {
  return `${baseKey}:${canonicalUserId(userId)}`
}
