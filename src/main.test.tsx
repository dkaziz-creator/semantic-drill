import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import { initializeStorage } from './services/storage'

vi.mock('react-dom/client', () => ({ createRoot: vi.fn() }))
vi.mock('./App', () => ({ default: () => null }))
vi.mock('./services/storage', () => ({ initializeStorage: vi.fn(), loadAppearance: vi.fn() }))
vi.mock('./utils/appearance', () => ({ applyAppearance: vi.fn() }))

const container = { textContent: '' }
const render = vi.fn()

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  container.textContent = ''
  vi.stubGlobal('document', { documentElement: {}, getElementById: () => container })
  vi.mocked(createRoot).mockReturnValue({ render, unmount: vi.fn() })
})

afterEach(() => vi.unstubAllGlobals())

describe('application startup', () => {
  it('renders React only after storage bootstrap resolves', async () => {
    let ready!: () => void
    vi.mocked(initializeStorage).mockReturnValue(new Promise<void>((resolve) => { ready = resolve }))
    await import('./main')
    expect(createRoot).not.toHaveBeenCalled()
    expect(container.textContent).toBe('Loading saved quizzes…')
    ready()
    await vi.waitFor(() => expect(render).toHaveBeenCalledOnce())
    expect(createRoot).toHaveBeenCalledWith(container)
  })

  it('shows a recoverable startup error without rendering an empty app or exposing error details', async () => {
    vi.mocked(initializeStorage).mockRejectedValue(new Error('test-only-sensitive-details'))
    await import('./main')
    await vi.waitFor(() => expect(container.textContent).toContain('could not be opened'))
    expect(container.textContent).not.toContain('test-only-sensitive-details')
    expect(createRoot).not.toHaveBeenCalled()
  })
})
