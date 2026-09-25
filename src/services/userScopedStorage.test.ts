import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import PouchDB from 'pouchdb-browser'
import * as databases from './learningDatabase'
import type { LearningDatabase, StoredLearningDocument } from './learningDatabase'
import {
  appendAttempt, clearAIKey, closeStorage, defaultAIConfig, flushStorage, initializeStorage,
  isStorageAvailable, loadAIConfig, loadAIKey, loadAppearance, loadAttempts, loadSavedQuizzes,
  loadSession, loadSoundPrefs, loadTheme, saveAIConfig, saveAIKey, saveSession, saveSoundPrefs,
  saveTheme, subscribeStorage, upsertSavedQuiz,
} from './storage'
import { installMemoryStorage, type MemoryStorage } from '../test/localStorageMock'
import { userScopedKey } from './userIdentity'
import { buildSession, createSavedQuiz, sessionToAttempt, sessionToProgress } from '../utils/library'

const questions = [{
  id: 1, question: 'A private study question?', options: ['A', 'B', 'C'],
  correctAnswers: ['A', 'C'], explanation: 'The original answer and explanation stay intact.',
}]
const settings = { shuffleQuestions: false, shuffleOptions: false, timerMinutes: 10, categories: [], passPercentage: 70 }
const originalOpen = databases.openLearningDatabase
let userA: string
let userB: string
let storage: MemoryStorage
let opened: LearningDatabase[]
let extraNames: string[]

function records() {
  const quiz = createSavedQuiz('Private quiz', questions)
  const session = buildSession(questions, settings, { quizId: quiz.id, quizName: quiz.name })
  session.answers = { 1: ['A', 'C'] }
  session.revealed = [1]
  quiz.progress = sessionToProgress(session)
  const attempt = sessionToAttempt({ ...session, status: 'finished' }, Date.now())
  quiz.lastAttemptId = attempt.id
  return { quiz, session, attempt }
}

beforeEach(() => {
  userA = crypto.randomUUID()
  userB = crypto.randomUUID()
  storage = installMemoryStorage()
  opened = []
  extraNames = []
  vi.spyOn(databases, 'openLearningDatabase').mockImplementation((id) => {
    const database = originalOpen(id)
    opened.push(database)
    vi.spyOn(database, 'changes')
    return database
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await closeStorage()
  for (const name of new Set([...opened.map((db) => db.name), ...extraNames])) {
    await new PouchDB(name, { adapter: 'idb' }).destroy()
  }
  vi.unstubAllGlobals()
})

describe('user-scoped learning storage', () => {
  it('flushes quiz/progress/session/history on logout, isolates B, and restores A unchanged', async () => {
    const { quiz, session, attempt } = records()
    await initializeStorage({ userId: userA })
    upsertSavedQuiz(quiz)
    saveSession(session)
    appendAttempt(attempt)
    // Deliberately do not flush: logout must drain all queued documents itself.
    await closeStorage()
    expect(() => loadSavedQuizzes()).toThrow('initializeStorage')
    await initializeStorage({ userId: userB })
    expect(loadSavedQuizzes()).toEqual([])
    expect(loadAttempts()).toEqual([])
    expect(loadSession()).toBeNull()
    expect(opened[0].name).toBe(`semantic-drill-learning-${userA}`)
    expect(opened[1].name).toBe(`semantic-drill-learning-${userB}`)
    expect(opened[0].name).not.toBe(opened[1].name)
    await initializeStorage({ userId: userA.toUpperCase() })
    expect(loadSavedQuizzes()).toEqual([quiz])
    expect(loadSession()).toEqual(session)
    expect(loadAttempts()).toEqual([attempt])
  })

  it('does not open or import the legacy database, learning keys, schema marker or AI secrets', async () => {
    const { quiz, session, attempt } = records()
    const legacy = new PouchDB<StoredLearningDocument>('semantic-drill-learning', { adapter: 'idb' })
    extraNames.push(legacy.name)
    await legacy.put({ _id: `quiz:${quiz.id}`, type: 'quiz', value: quiz, order: 1 })
    const legacyInfo = await legacy.info()
    const backups = {
      'drillmcq_saved_quizzes.v1': JSON.stringify([quiz]),
      'drillmcq_quiz_results.v1': JSON.stringify([attempt]),
      'drillmcq_active_session.v1': JSON.stringify(session),
      'drillmcq.session.v1': '{corrupt legacy data',
      'drillmcq_schema_version': '1',
      'drillmcq_ai_key.v1': 'legacy-private-secret',
      'drillmcq_ai_prefs.v1': JSON.stringify({ ...defaultAIConfig(), rememberKey: true }),
    }
    for (const [key, value] of Object.entries(backups)) storage.setItem(key, value)
    for (const userId of [userA, userB]) {
      await initializeStorage({ userId })
      expect(loadSavedQuizzes()).toEqual([])
      expect(loadAttempts()).toEqual([])
      expect(loadSession()).toBeNull()
      expect(loadAIKey()).toBeNull()
      expect(loadAIConfig()).toEqual(defaultAIConfig())
      await expect(opened.at(-1)!.get('_local/learning-localstorage-v1')).rejects.toMatchObject({ status: 404 })
    }
    expect((await legacy.info()).update_seq).toBe(legacyInfo.update_seq)
    expect((await legacy.get(`quiz:${quiz.id}`)).value).toEqual(quiz)
    for (const [key, value] of Object.entries(backups)) expect(storage.getItem(key)).toBe(value)
    await legacy.close()
  })

  it('scopes AI configuration and secrets while sharing only cosmetic preferences', async () => {
    await initializeStorage({ userId: userA })
    const config = { ...defaultAIConfig(), enabled: true, rememberKey: true }
    saveAIConfig(config)
    saveAIKey('a-private-key')
    saveTheme('dark')
    saveSoundPrefs({ enabled: false })
    expect(storage.getItem(userScopedKey('drillmcq_ai_key.v1', userA))).toBe('a-private-key')
    const switching = initializeStorage({ userId: userB })
    expect(loadAIKey()).toBeNull()
    expect(loadAIConfig()).toEqual(defaultAIConfig())
    expect(() => loadSession()).toThrow('initializeStorage')
    await switching
    expect(loadAIKey()).toBeNull()
    expect(loadAIConfig()).toEqual(defaultAIConfig())
    expect(loadTheme()).toBe('dark')
    expect(loadSoundPrefs()).toEqual({ enabled: false })
    expect(loadAppearance()).toBeDefined()
    saveAIKey('b-private-key')
    clearAIKey()
    await initializeStorage({ userId: userA })
    expect(loadAIKey()).toBe('a-private-key')
    expect(loadAIConfig()).toEqual(config)
    await closeStorage()
    expect(loadAIKey()).toBeNull()
    saveAIKey('signed-out-write')
    expect(storage.getItem(userScopedKey('drillmcq_ai_key.v1', userA))).toBe('a-private-key')
  })

  it('rejects invalid identity before any database opens', async () => {
    for (const userId of ['david', '../../foo', '', `semantic-drill-user-${userA}`]) {
      await expect(initializeStorage({ userId })).rejects.toThrow('internal user UUID')
    }
    expect(databases.openLearningDatabase).not.toHaveBeenCalled()
  })

  it('coalesces one identity and serializes overlapping open/close/switch calls', async () => {
    const first = initializeStorage({ userId: userA })
    expect(initializeStorage({ userId: userA.toUpperCase() })).toBe(first)
    const closing = closeStorage()
    const last = initializeStorage({ userId: userB })
    await Promise.all([first, closing, last])
    expect(opened.map((db) => db.name)).toEqual([`semantic-drill-learning-${userB}`])
    expect(loadSavedQuizzes()).toEqual([])
    expect(isStorageAvailable()).toBe(true)
  })

  it('retains failed pending writes and refuses to open B until A can flush successfully', async () => {
    const { quiz } = records()
    await initializeStorage({ userId: userA })
    const oldDatabase = opened[0]
    const close = vi.spyOn(oldDatabase, 'close')
    const put = vi.spyOn(oldDatabase, 'put').mockRejectedValue({ status: 507 })
    upsertSavedQuiz(quiz)
    await expect(flushStorage()).rejects.toMatchObject({ status: 507 })
    await expect(initializeStorage({ userId: userB })).rejects.toMatchObject({ status: 507 })
    expect(opened).toHaveLength(1)
    expect(close).not.toHaveBeenCalled()
    expect(() => loadSavedQuizzes()).toThrow('initializeStorage')
    put.mockRestore()
    await initializeStorage({ userId: userB })
    expect(close).toHaveBeenCalledOnce()
    expect(loadSavedQuizzes()).toEqual([])
    await initializeStorage({ userId: userA })
    expect(loadSavedQuizzes()).toEqual([quiz])
  })

  it('ignores old feed events and a refresh already in flight during account switching', async () => {
    const { quiz } = records()
    await initializeStorage({ userId: userA })
    const database = opened[0]
    const changes = vi.mocked(database.changes)
    const liveIndex = changes.mock.calls.findIndex(([options]) => options?.live)
    const feed = changes.mock.results[liveIndex].value as PouchDB.Core.Changes<StoredLearningDocument>
    const oldChange = feed.listeners('change').at(-1)!
    const oldError = feed.listeners('error').at(-1)!
    const listener = vi.fn()
    subscribeStorage(listener)
    let release!: (doc: PouchDB.Core.ExistingDocument<StoredLearningDocument>) => void
    const documentReader: { get(id: string): Promise<PouchDB.Core.ExistingDocument<StoredLearningDocument>> } = database
    const get = vi.spyOn(documentReader, 'get').mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    oldChange({ id: `quiz:${quiz.id}`, seq: 1 })
    await vi.waitFor(() => expect(get).toHaveBeenCalled())
    const switching = initializeStorage({ userId: userB })
    release({ _id: `quiz:${quiz.id}`, _rev: '1-old', type: 'quiz', value: quiz, order: 1 })
    await switching
    listener.mockClear()
    oldChange({ id: `quiz:${quiz.id}`, seq: 1 })
    oldError(new Error('old transport details'))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(loadSavedQuizzes()).toEqual([])
    expect(isStorageAvailable()).toBe(true)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('authenticated native sync', () => {
  it('uses the same logical URL for both users and cancels replication only after local writes flush', async () => {
    vi.stubGlobal('location', { href: 'https://study.example/app/' })
    const targets: string[] = []
    const cancellations: MockInstance<() => void>[] = []
    vi.mocked(databases.openLearningDatabase).mockImplementation((id) => {
      const database = originalOpen(id)
      opened.push(database)
      const peer = new PouchDB<StoredLearningDocument>(`peer-${id}`, { adapter: 'idb' })
      extraNames.push(peer.name)
      const replication = database.sync(peer, { live: true, retry: true })
      const cancel = vi.spyOn(replication, 'cancel')
      cancellations.push(cancel)
      vi.spyOn(database, 'sync').mockImplementation((remote, options) => {
        targets.push(typeof remote === 'string' ? remote : remote.name)
        expect(options).toEqual({ live: true, retry: true })
        return replication
      })
      return database
    })
    const { quiz, attempt } = records()
    await initializeStorage({ userId: userA, remoteUrl: '/couchdb/my/' })
    const peer = new PouchDB<StoredLearningDocument>(`peer-${userA}`, { adapter: 'idb' })
    upsertSavedQuiz(quiz)
    await flushStorage()
    await vi.waitFor(async () => expect((await peer.get(`quiz:${quiz.id}`)).value).toEqual(quiz))
    await peer.put({ _id: `attempt:${attempt.id}`, type: 'attempt', value: attempt, order: 2 })
    await vi.waitFor(() => expect(loadAttempts()).toEqual([attempt]))
    // Leave a final queued local write for switch-time flushing.
    upsertSavedQuiz({ ...quiz, name: 'Last write before switching' })
    await initializeStorage({ userId: userB, remoteUrl: '/couchdb/my/' })
    expect(cancellations[0]).toHaveBeenCalled()
    expect(targets).toEqual(['https://study.example/couchdb/my/', 'https://study.example/couchdb/my/'])
    expect(targets.join()).not.toContain(userA)
    expect(targets.join()).not.toContain(userB)
    expect(loadSavedQuizzes()).toEqual([])
    expect(loadAttempts()).toEqual([])
    await initializeStorage({ userId: userA })
    expect(loadSavedQuizzes()[0].name).toBe('Last write before switching')
    await peer.close()
  })

  it('aborts outstanding native HTTP requests when the old store closes', async () => {
    vi.stubGlobal('location', { href: 'https://study.example/' })
    const local = databases.openLearningDatabase(userA)
    const peer = databases.openLearningDatabase(userB)
    const replication = local.sync(peer, { live: true, retry: true })
    let remote: LearningDatabase | undefined
    vi.spyOn(local, 'sync').mockImplementation((target) => {
      if (typeof target === 'string') throw new Error('Expected a native remote database')
      remote = target
      return replication
    })
    let signal: AbortSignal | null | undefined
    vi.spyOn(PouchDB, 'fetch').mockImplementation((_input, options) => new Promise((_resolve, reject) => {
      expect(new Headers(options?.headers).get('X-Study-User')).toBe(userA)
      signal = options?.signal
      signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const store = new databases.LearningStore(local, () => null, vi.fn())
    await store.initialize()
    store.startSync('/couchdb/my/', userA)
    const request = remote!.allDocs().catch((error: unknown) => error)
    await vi.waitFor(() => expect(signal).toBeDefined())
    expect(signal?.aborted).toBe(false)
    await store.close()
    expect(signal?.aborted).toBe(true)
    expect(await request).toMatchObject({ name: 'AbortError' })
    await peer.close()
  })

  it.each([
    'https://private:secret@study.example/couchdb/my/', '/couchdb/my/?token=secret',
    '/couchdb/my/#secret', '/couchdb/semantic-drill-user-private', 'file:///couchdb/my/',
    'https://another.example/couchdb/my/', '%%%malformed',
  ])('keeps local data usable for invalid sync configuration: %s', async (remoteUrl) => {
    vi.stubGlobal('location', { href: 'https://study.example/' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await initializeStorage({ userId: userA, remoteUrl })
    const { quiz } = records()
    upsertSavedQuiz(quiz)
    await flushStorage()
    expect(isStorageAvailable()).toBe(true)
    expect(loadSavedQuizzes()).toEqual([quiz])
    expect(warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(remoteUrl)
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret')
  })
})
