import { canonicalUserId, type AuthenticatedUser } from './userIdentity'

/** Replace this provider when login is added; storage only consumes the UUID. */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser> {
  try {
    // Explicit local development fixture only. Production never trusts a Vite
    // identity, a URL parameter, a display name, or a localStorage value.
    if (import.meta.env.DEV && import.meta.env.VITE_DEV_USER_ID) {
      return { id: canonicalUserId(import.meta.env.VITE_DEV_USER_ID) }
    }
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error('Authentication unavailable.')
    const value: unknown = await response.json()
    if (typeof value !== 'object' || value === null || !('id' in value)) {
      throw new Error('Invalid identity.')
    }
    return {
      id: canonicalUserId(value.id),
      ...('displayName' in value && typeof value.displayName === 'string'
        ? { displayName: value.displayName } : {}),
    }
  } catch {
    // Transport errors and server responses may contain private details.
    throw new Error('Your study identity could not be verified.')
  }
}
