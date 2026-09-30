import { canonicalUserId, type AuthenticatedUser } from './userIdentity'

/** Identity comes from the session; 401 opens the sign-in shell. */
export async function getAuthenticatedUser(): Promise<AuthenticatedUser | null> {
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
    if (response.status === 401) return null
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

/** Call only inside studyApplication.changeAccount, after writes/sync close. */
export async function signIn(login: string, password: string): Promise<void> {
  let response: Response
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ login, password }),
    })
  } catch { throw new Error('Sign-in is unavailable. Please try again.') }
  if (response.status === 401) throw new Error('Invalid login or password.')
  if (response.status === 429) throw new Error('Too many sign-in attempts. Please try again in five minutes.')
  if (!response.ok) throw new Error('Sign-in is unavailable. Please try again.')
}

export async function signOut(): Promise<null> {
  try {
    const response = await fetch('/api/auth/logout', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    })
    if (!response.ok) throw new Error()
    return null
  } catch { throw new Error('Sign-out could not be completed. Please retry.') }
}
