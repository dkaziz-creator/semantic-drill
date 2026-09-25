import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAuthenticatedUser } from './authentication'

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
    await expect(getAuthenticatedUser()).rejects.toThrow('Your study identity could not be verified.')
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
