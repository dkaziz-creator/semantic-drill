import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthenticatedUser, signIn, signOut } from './authentication'

const USER = '550e8400-e29b-41d4-a716-446655440000'
const request = vi.fn<typeof fetch>()

beforeEach(() => {
  request.mockReset()
  vi.stubGlobal('fetch', request)
  vi.stubEnv('DEV', false)
  vi.stubEnv('VITE_DEV_USER_ID', '')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('identity provider', () => {
  it('obtains a validated canonical internal UUID from the trusted session endpoint', async () => {
    request.mockResolvedValue(Response.json({ id: USER.toUpperCase(), displayName: 'David', database: 'ignored' }))
    expect(await getAuthenticatedUser()).toEqual({ id: USER, displayName: 'David' })
    expect(request).toHaveBeenCalledWith('/api/auth/me', {
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' },
    })
  })

  it('supports an explicit development fixture without requiring a login UI', async () => {
    vi.stubEnv('DEV', true)
    vi.stubEnv('VITE_DEV_USER_ID', USER)
    expect(await getAuthenticatedUser()).toEqual({ id: USER })
    expect(request).not.toHaveBeenCalled()
  })

  it('ignores development identity configuration in production', async () => {
    vi.stubEnv('VITE_DEV_USER_ID', USER)
    request.mockResolvedValue(new Response(null, { status: 401 }))
    expect(await getAuthenticatedUser()).toBe(null)
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([null, {}, { id: '../../private' }, { id: 'david' }, { id: USER + '\n' }])('rejects malformed server identities: %j', async (value) => {
    request.mockResolvedValue(Response.json(value))
    await expect(getAuthenticatedUser()).rejects.toThrow('Your study identity could not be verified.')
  })

  it('redacts transport details and rejects instead of falling back to shared storage', async () => {
    request.mockRejectedValue(new Error('https://private:secret@example.test'))
    await expect(getAuthenticatedUser()).rejects.toThrow('Your study identity could not be verified.')
  })
})


describe('session mutation requests', () => {
  it('sends same-origin credentials and never exposes server error details', async () => {
    request.mockResolvedValue(new Response('private server details', { status: 401 }))
    await expect(signIn('david', 'password')).rejects.toThrow('Invalid login or password.')
    expect(request).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({
      method: 'POST', credentials: 'same-origin', body: JSON.stringify({ login: 'david', password: 'password' }),
    }))
    request.mockResolvedValue(new Response(null, { status: 200 }))
    expect(await signOut()).toBe(null)
    expect(request).toHaveBeenLastCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST', credentials: 'same-origin' }))
  })
  it('treats service errors as failures, never as anonymous identities', async () => {
    request.mockResolvedValue(new Response(null, { status: 503 }))
    await expect(getAuthenticatedUser()).rejects.toThrow('could not be verified')
    await expect(signOut()).rejects.toThrow('Sign-out could not be completed')
    request.mockResolvedValue(new Response(null, { status: 429 }))
    await expect(signIn('david', 'password')).rejects.toThrow('five minutes')
  })
})
