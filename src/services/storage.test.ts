import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PouchDB from 'pouchdb-browser'
import type { LearningDatabase, StoredLearningDocument } from './learningDatabase'
import type { QuizAttempt, QuizQuestion, QuizSession, SavedQuiz } from '../types/quiz'
import {
  appendAttempt,
  clearAIKey,
  clearSession,
  defaultAIConfig,
  defaultAppearance,
  deleteAttempt,
  deleteSavedQuiz,
  fingerprintQuestions,
  isStorageAvailable,
  loadAIConfig,
  loadAIKey,
  loadAppearance,
  loadAttempts,
  loadSavedQuizzes,
  loadSession,
  loadSoundPrefs,
  loadTheme,
  patchSavedQuiz,
  initializeLegacyStorage as initializeStorage,
  closeStorage,
  flushStorage,
  subscribeStorage,
  saveAIConfig,
  saveAIKey,
  saveAppearance,
  saveSession,
  saveSoundPrefs,
  saveTheme,
  SCHEMA_VERSION,
  upsertSavedQuiz,
} from './storage'
import { installBlockedStorage, installMemoryStorage, type MemoryStorage } from '../test/localStorageMock'

const SAVED_QUIZZES_KEY = 'drillmcq_saved_quizzes.v1'
const RESULTS_KEY = 'drillmcq_quiz_results.v1'
const SESSION_KEY = 'drillmcq_active_session.v1'
const LEGACY_SESSION_KEY = 'drillmcq.session.v1'
const AI_PREFS_KEY = 'drillmcq_ai_prefs.v1'
const AI_KEY_KEY = 'drillmcq_ai_key.v1'
const APPEARANCE_KEY = 'drillmcq_appearance.v1'
const SOUND_KEY = 'drillmcq_sound.v1'

const questions: QuizQuestion[] = [
  { id: 1, question: 'Capital of France?', options: ['Paris', 'Rome'], correctAnswers: ['Paris'] },
  { id: 2, question: '2 + 2?', options: ['3', '4'], correctAnswers: ['4'], category: 'Maths' },
]

function makeQuiz(overrides: Partial<SavedQuiz> = {}): SavedQuiz {
  return {
    id: 'quiz_1',
    name: 'Geography',
    questions,
    createdAt: 1000,
    updatedAt: 1000,
    fingerprint: fingerprintQuestions(questions),
    ...overrides,
  }
}

function makeAttempt(overrides: Partial<QuizAttempt> = {}): QuizAttempt {
  return {
    id: 'attempt_1',
    quizId: 'quiz_1',
    quizName: 'Geography',
    startedAt: 1000,
    completedAt: 2000,
    timeTakenSeconds: 1,
    correct: 1,
    incorrect: 1,
    unanswered: 0,
    total: 2,
    percentage: 50,
    settings: { shuffleQuestions: false, shuffleOptions: false, timerMinutes: 0, categories: [], passPercentage: 70 },
    questions,
    answers: { 1: ['Paris'], 2: ['3'] },
    ...overrides,
  }
}

function makeSession(overrides: Partial<QuizSession> = {}): QuizSession {
  return {
    questions,
    answers: { 1: ['Paris'] },
    drafts: {},
    revealed: [],
    currentIndex: 1,
    status: 'active',
    startedAt: 5000,
    timerMinutes: 10,
    attemptId: 'attempt_live',
    settings: { shuffleQuestions: true, shuffleOptions: false, timerMinutes: 10, categories: [], passPercentage: 70 },
    quizId: 'quiz_1',
    quizName: 'Geography',
    ...overrides,
  }
}

let storage: MemoryStorage
let database: LearningDatabase

beforeEach(() => {
  storage = installMemoryStorage()
  database = new PouchDB<StoredLearningDocument>(`storage-test-${crypto.randomUUID()}`, { adapter: 'idb' })
})

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  await closeStorage()
  await new PouchDB(database.name).destroy()
  installMemoryStorage()
})

describe('saved quiz library', () => {
  beforeEach(() => initializeStorage({ database }))

  it('starts empty', () => {
    expect(loadSavedQuizzes()).toEqual([])
  })

  it('saves a quiz and loads it back', () => {
    upsertSavedQuiz(makeQuiz())
    const loaded = loadSavedQuizzes()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('Geography')
    expect(loaded[0].questions).toHaveLength(2)
  })

  it('saves multiple distinct quizzes', () => {
    upsertSavedQuiz(makeQuiz())
    upsertSavedQuiz(makeQuiz({ id: 'quiz_2', name: 'Maths' }))
    expect(loadSavedQuizzes().map((q) => q.id)).toEqual(['quiz_1', 'quiz_2'])
  })

  it('updates an existing quiz in place instead of duplicating it', () => {
    upsertSavedQuiz(makeQuiz())
    upsertSavedQuiz(makeQuiz({ name: 'Geography v2', updatedAt: 3000 }))
    const loaded = loadSavedQuizzes()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].name).toBe('Geography v2')
    expect(loaded[0].updatedAt).toBe(3000)
  })

  it('patches one quiz and leaves the others alone', () => {
    upsertSavedQuiz(makeQuiz())
    upsertSavedQuiz(makeQuiz({ id: 'quiz_2', name: 'Maths' }))
    patchSavedQuiz('quiz_2', (quiz) => ({ ...quiz, name: 'Maths (revised)' }))
    const loaded = loadSavedQuizzes()
    expect(loaded.find((q) => q.id === 'quiz_1')?.name).toBe('Geography')
    expect(loaded.find((q) => q.id === 'quiz_2')?.name).toBe('Maths (revised)')
  })

  it('ignores a patch for an unknown id', () => {
    upsertSavedQuiz(makeQuiz())
    expect(patchSavedQuiz('nope', (quiz) => ({ ...quiz, name: 'x' }))).toHaveLength(1)
    expect(loadSavedQuizzes()[0].name).toBe('Geography')
  })

  it('deletes a quiz together with its attempt history', () => {
    upsertSavedQuiz(makeQuiz())
    upsertSavedQuiz(makeQuiz({ id: 'quiz_2', name: 'Maths' }))
    appendAttempt(makeAttempt())
    appendAttempt(makeAttempt({ id: 'attempt_2', quizId: 'quiz_2' }))

    deleteSavedQuiz('quiz_1')

    expect(loadSavedQuizzes().map((q) => q.id)).toEqual(['quiz_2'])
    expect(loadAttempts().map((a) => a.id)).toEqual(['attempt_2'])
  })

  it('fingerprints identical question banks identically', () => {
    expect(fingerprintQuestions(questions)).toBe(fingerprintQuestions([...questions]))
    expect(fingerprintQuestions(questions)).not.toBe(fingerprintQuestions([questions[0]]))
  })
})

describe('results history', () => {
  beforeEach(() => initializeStorage({ database }))

  it('starts empty', () => {
    expect(loadAttempts()).toEqual([])
  })

  it('keeps every attempt, newest appended', () => {
    appendAttempt(makeAttempt())
    appendAttempt(makeAttempt({ id: 'attempt_2', percentage: 100, completedAt: 3000 }))
    const loaded = loadAttempts()
    expect(loaded).toHaveLength(2)
    expect(loaded.map((a) => a.percentage)).toEqual([50, 100])
  })

  it('does not record the same attempt id twice', () => {
    appendAttempt(makeAttempt())
    appendAttempt(makeAttempt({ percentage: 90 }))
    expect(loadAttempts()).toHaveLength(1)
    expect(loadAttempts()[0].percentage).toBe(50)
  })

  it('deletes a single attempt and keeps the rest', () => {
    appendAttempt(makeAttempt())
    appendAttempt(makeAttempt({ id: 'attempt_2' }))
    deleteAttempt('attempt_1')
    expect(loadAttempts().map((a) => a.id)).toEqual(['attempt_2'])
  })

  it('clears a saved quiz reference to a deleted attempt', () => {
    upsertSavedQuiz(makeQuiz({ lastAttemptId: 'attempt_1' }))
    appendAttempt(makeAttempt())
    deleteAttempt('attempt_1')
    expect(loadSavedQuizzes()[0].lastAttemptId).toBeUndefined()
  })
})

describe('active session', () => {
  beforeEach(() => initializeStorage({ database }))

  it('round-trips a session', () => {
    const session = makeSession()
    saveSession(session)
    const loaded = loadSession()
    expect(loaded?.answers).toEqual({ 1: ['Paris'] })
    expect(loaded?.currentIndex).toBe(1)
    expect(loaded?.attemptId).toBe('attempt_live')
    expect(loaded?.quizId).toBe('quiz_1')
    expect(loaded?.settings.timerMinutes).toBe(10)
  })

  it('clears the session', () => {
    saveSession(makeSession())
    clearSession()
    expect(loadSession()).toBeNull()
  })

  it('clamps a current index that points past the questions', () => {
    saveSession(makeSession({ currentIndex: 99 }))
    expect(loadSession()?.currentIndex).toBe(1)
  })
})

describe('corrupted and hostile storage', () => {
  it('recovers from a session entry that is not JSON', async () => {
    storage.setItem(SESSION_KEY, '{not json')
    await initializeStorage({ database })
    expect(loadSession()).toBeNull()
    expect(storage.getItem(SESSION_KEY)).toBe('{not json')
  })

  it('rejects a session whose questions are missing', async () => {
    storage.setItem(SESSION_KEY, JSON.stringify({ answers: {}, currentIndex: 0 }))
    await initializeStorage({ database })
    expect(loadSession()).toBeNull()
  })

  it('backfills fields missing from a pre-library session', async () => {
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({
        questions,
        answers: { 1: 'Paris' },
        currentIndex: 0,
        status: 'active',
        startedAt: 42,
        timerMinutes: 5,
      }),
    )
    await initializeStorage({ database })
    const loaded = loadSession()
    expect(loaded).not.toBeNull()
    expect(loaded?.attemptId).toMatch(/^attempt_/)
    expect(loaded?.settings.timerMinutes).toBe(5)
    expect(loaded?.quizId).toBeUndefined()
  })

  it('returns an empty library when the stored value is not an array', async () => {
    storage.setItem(SAVED_QUIZZES_KEY, JSON.stringify({ nope: true }))
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([])
  })

  it('drops only the invalid entries from a partly corrupted library', async () => {
    storage.setItem(
      SAVED_QUIZZES_KEY,
      JSON.stringify([makeQuiz(), { id: 'broken' }, null, makeQuiz({ id: 'quiz_3' })]),
    )
    await initializeStorage({ database })
    expect(loadSavedQuizzes().map((q) => q.id)).toEqual(['quiz_1', 'quiz_3'])
  })

  it('drops only the invalid entries from a partly corrupted history', async () => {
    storage.setItem(RESULTS_KEY, JSON.stringify([makeAttempt(), 'garbage']))
    await initializeStorage({ database })
    expect(loadAttempts().map((a) => a.id)).toEqual(['attempt_1'])
  })

  it('repairs a saved quiz that lost its fingerprint', async () => {
    storage.setItem(SAVED_QUIZZES_KEY, JSON.stringify([{ ...makeQuiz(), fingerprint: undefined }]))
    await initializeStorage({ database })
    expect(loadSavedQuizzes()[0].fingerprint).toBe(fingerprintQuestions(questions))
  })

  it('persists learning data even when localStorage is full', async () => {
    storage.full = true
    await initializeStorage({ database })
    expect(() => upsertSavedQuiz(makeQuiz())).not.toThrow()
    expect(() => appendAttempt(makeAttempt())).not.toThrow()
    expect(() => saveSession(makeSession())).not.toThrow()
    expect(isStorageAvailable()).toBe(true)
    expect(loadSavedQuizzes()).toHaveLength(1)
    await flushStorage()
    expect((await database.get('quiz:quiz_1')).value).toMatchObject({ id: 'quiz_1' })
  })

  it('keeps working when localStorage access throws', async () => {
    installBlockedStorage()
    await initializeStorage({ database })
    expect(isStorageAvailable()).toBe(true)
    expect(loadSavedQuizzes()).toEqual([])
    expect(loadAttempts()).toEqual([])
    expect(loadSession()).toBeNull()
    expect(loadTheme()).toBeNull()
    expect(() => saveTheme('dark')).not.toThrow()
    expect(() => deleteSavedQuiz('quiz_1')).not.toThrow()
  })
})

describe('migration', () => {
  it('adopts a session written by the pre-library build', async () => {
    storage.setItem(
      LEGACY_SESSION_KEY,
      JSON.stringify({
        questions,
        answers: { 1: 'Paris' },
        currentIndex: 1,
        status: 'active',
        startedAt: 7,
        timerMinutes: 0,
      }),
    )

    await initializeStorage({ database })
    const loaded = loadSession()

    expect(loaded?.answers).toEqual({ 1: ['Paris'] })
    expect(loaded?.currentIndex).toBe(1)
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(SCHEMA_VERSION))
  })

  it('upgrades pre-multi-answer questions and answers during import', async () => {
    // Exactly what a v1 build wrote: a single `correctAnswer` string per
    // question and a bare string per answer.
    const legacyQuestions = [
      { id: 1, question: 'Capital of France?', options: ['Paris', 'Rome'], correctAnswer: 'Paris' },
    ]
    storage.setItem('drillmcq_schema_version', '1')
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({
        questions: legacyQuestions,
        answers: { 1: 'Paris' },
        currentIndex: 0,
        status: 'active',
        startedAt: 7,
        timerMinutes: 0,
        attemptId: 'attempt_old',
      }),
    )
    storage.setItem(
      SAVED_QUIZZES_KEY,
      JSON.stringify([{ ...makeQuiz(), questions: legacyQuestions }]),
    )
    storage.setItem(
      RESULTS_KEY,
      JSON.stringify([{ ...makeAttempt(), questions: legacyQuestions, answers: { 1: 'Paris' } }]),
    )

    await initializeStorage({ database })
    const session = loadSession()
    expect(session?.questions[0].correctAnswers).toEqual(['Paris'])
    expect(session?.answers).toEqual({ 1: ['Paris'] })
    expect(session?.drafts).toEqual({})
    expect(loadSavedQuizzes()[0].questions[0].correctAnswers).toEqual(['Paris'])
    expect(loadAttempts()[0].answers).toEqual({ 1: ['Paris'] })
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(SCHEMA_VERSION))

    // IndexedDB receives the upgrade; the original legacy backup is untouched.
    expect((await database.get('session:active')).value).toMatchObject({
      questions: [{ correctAnswers: ['Paris'] }],
    })
    expect(storage.getItem(SESSION_KEY)).toContain('correctAnswer')
    expect(storage.getItem(SESSION_KEY)).not.toContain('correctAnswers')
  })

  it('does not clobber an existing session with the legacy one', async () => {
    storage.setItem(SESSION_KEY, JSON.stringify(makeSession({ attemptId: 'current' })))
    storage.setItem(LEGACY_SESSION_KEY, JSON.stringify(makeSession({ attemptId: 'legacy' })))
    await initializeStorage({ database })
    expect(loadSession()?.attemptId).toBe('current')
  })

  it('backfills an empty reveal set on a session written before "Check Answer"', async () => {
    const preReveal: Record<string, unknown> = { ...makeSession() }
    delete preReveal.revealed
    storage.setItem(SESSION_KEY, JSON.stringify(preReveal))

    // The run resumes with nothing revealed, rather than being thrown away.
    await initializeStorage({ database })
    expect(loadSession()?.revealed).toEqual([])
    expect(loadSession()?.answers).toEqual({ 1: ['Paris'] })
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(SCHEMA_VERSION))
  })

  it('keeps a stored reveal set, dropping junk entries', async () => {
    storage.setItem(
      SESSION_KEY,
      JSON.stringify(makeSession({ revealed: [1, 1, 'two', null, 2] as unknown as number[] })),
    )
    await initializeStorage({ database })
    expect(loadSession()?.revealed).toEqual([1, 2])
  })

  it('backfills the pass mark on records written before it existed', async () => {
    const stripPassMark = (settings: Record<string, unknown>) => {
      const copy = { ...settings }
      delete copy.passPercentage
      return copy
    }
    storage.setItem('drillmcq_schema_version', '3')
    const session = makeSession()
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...session, settings: stripPassMark({ ...session.settings }) }),
    )
    const quiz = makeQuiz()
    storage.setItem(
      SAVED_QUIZZES_KEY,
      JSON.stringify([
        {
          ...quiz,
          progress: {
            ...makeSession(),
            updatedAt: 9000,
            settings: stripPassMark({ ...session.settings }),
          },
        },
      ]),
    )
    const attempt = makeAttempt()
    storage.setItem(
      RESULTS_KEY,
      JSON.stringify([{ ...attempt, settings: stripPassMark({ ...attempt.settings }) }]),
    )

    // The default is what these runs were effectively judged against, and the
    // rest of each record — including the timer — survives untouched.
    await initializeStorage({ database })
    expect(loadSession()?.settings.passPercentage).toBe(70)
    expect(loadSession()?.settings.timerMinutes).toBe(10)
    expect(loadSavedQuizzes()[0].progress?.settings.passPercentage).toBe(70)
    expect(loadAttempts()[0].settings.passPercentage).toBe(70)
    expect(loadAttempts()[0].percentage).toBe(50)
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(SCHEMA_VERSION))
  })

  it('clamps a hand-edited pass mark into 0–100', async () => {
    const session = makeSession()
    storage.setItem(
      SESSION_KEY,
      JSON.stringify({ ...session, settings: { ...session.settings, passPercentage: 250 } }),
    )
    await initializeStorage({ database })
    expect(loadSession()?.settings.passPercentage).toBe(100)
  })

  it('leaves an already-migrated store untouched', async () => {
    storage.setItem('drillmcq_schema_version', String(SCHEMA_VERSION))
    storage.setItem(LEGACY_SESSION_KEY, JSON.stringify(makeSession({ attemptId: 'legacy' })))
    await initializeStorage({ database })
    expect(loadSession()).toBeNull()
  })
})

describe('AI preferences', () => {
  beforeEach(() => initializeStorage({ database }))

  it('returns defaults when nothing is stored', () => {
    const config = loadAIConfig()
    expect(config.enabled).toBe(false)
    expect(config.provider).toBe('openai')
    expect(config.rememberKey).toBe(false)
    expect(config.maxBatchQuestions).toBe(50)
  })

  it('round-trips preferences', () => {
    saveAIConfig({
      ...defaultAIConfig(),
      enabled: true,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      maxBatchQuestions: 25,
    })
    const loaded = loadAIConfig()
    expect(loaded.enabled).toBe(true)
    expect(loaded.provider).toBe('anthropic')
    expect(loaded.model).toBe('claude-sonnet-5')
    expect(loaded.maxBatchQuestions).toBe(25)
  })

  it('repairs garbage instead of throwing or disabling the app', () => {
    storage.setItem(
      AI_PREFS_KEY,
      JSON.stringify({ enabled: 'yes', provider: 'skynet', model: 42, maxBatchQuestions: -5 }),
    )
    const config = loadAIConfig()
    expect(config.enabled).toBe(false) // only a literal true counts
    expect(config.provider).toBe('openai') // unknown provider falls back
    expect(config.model).toBe('') // non-string model dropped
    expect(config.maxBatchQuestions).toBe(1) // clamped into range
  })

  it('clamps an absurd batch size', () => {
    storage.setItem(AI_PREFS_KEY, JSON.stringify({ maxBatchQuestions: 10_000 }))
    expect(loadAIConfig().maxBatchQuestions).toBe(200)
  })

  it('survives a non-object entry', () => {
    storage.setItem(AI_PREFS_KEY, '"nonsense"')
    expect(() => loadAIConfig()).not.toThrow()
    expect(loadAIConfig().provider).toBe('openai')
  })

  it('does not bump the schema version or add a migration step', () => {
    // The AI keys are new, so there is no older shape to repair — writing
    // preferences must leave the version wherever the quiz shapes put it.
    const before = SCHEMA_VERSION
    saveAIConfig(defaultAIConfig())
    expect(SCHEMA_VERSION).toBe(before)
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(before))
  })
})

describe('appearance preferences', () => {
  beforeEach(() => initializeStorage({ database }))

  it('returns the shipped look when nothing is stored', () => {
    const prefs = loadAppearance()
    expect(prefs.font).toBe('sans')
    expect(prefs.fontScale).toBe(1)
    expect(prefs.background).toBe('default')
  })

  it('round-trips preferences', () => {
    saveAppearance({ font: 'serif', fontScale: 1.3, background: 'warm' })
    const loaded = loadAppearance()
    expect(loaded.font).toBe('serif')
    expect(loaded.fontScale).toBe(1.3)
    expect(loaded.background).toBe('warm')
  })

  it('repairs garbage instead of throwing or disabling the app', () => {
    storage.setItem(
      APPEARANCE_KEY,
      JSON.stringify({ font: 'papyrus', fontScale: 'huge', background: 42 }),
    )
    const prefs = loadAppearance()
    expect(prefs.font).toBe('sans') // unknown font falls back
    expect(prefs.fontScale).toBe(1) // non-numeric scale dropped
    expect(prefs.background).toBe('default')
  })

  it('clamps an absurd text size at both ends', () => {
    storage.setItem(APPEARANCE_KEY, JSON.stringify({ fontScale: 99 }))
    expect(loadAppearance().fontScale).toBe(1.6)
    storage.setItem(APPEARANCE_KEY, JSON.stringify({ fontScale: 0.01 }))
    expect(loadAppearance().fontScale).toBe(0.8)
  })

  it('survives a non-object entry', () => {
    storage.setItem(APPEARANCE_KEY, '"nonsense"')
    expect(() => loadAppearance()).not.toThrow()
    expect(loadAppearance().font).toBe('sans')
  })

  it('does not bump the schema version or add a migration step', () => {
    const before = SCHEMA_VERSION
    saveAppearance(defaultAppearance())
    expect(SCHEMA_VERSION).toBe(before)
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(before))
  })

  it('is independent of the theme key', () => {
    // Separate entries: changing the palette must never disturb dark mode.
    saveTheme('dark')
    saveAppearance({ font: 'mono', fontScale: 0.9, background: 'contrast' })
    expect(loadTheme()).toBe('dark')
    expect(loadAppearance().font).toBe('mono')
  })
})

describe('sound preferences', () => {
  beforeEach(() => initializeStorage({ database }))

  it('is on when nothing is stored', () => {
    expect(loadSoundPrefs()).toEqual({ enabled: true })
  })

  it('round-trips the off state', () => {
    saveSoundPrefs({ enabled: false })
    expect(loadSoundPrefs().enabled).toBe(false)
  })

  it('repairs a non-boolean back to the shipped default', () => {
    storage.setItem(SOUND_KEY, JSON.stringify({ enabled: 'yes' }))
    expect(loadSoundPrefs().enabled).toBe(true)
  })

  it('survives a non-object entry', () => {
    storage.setItem(SOUND_KEY, '"nonsense"')
    expect(() => loadSoundPrefs()).not.toThrow()
    expect(loadSoundPrefs().enabled).toBe(true)
  })

  it('does not bump the schema version or add a migration step', () => {
    const before = SCHEMA_VERSION
    saveSoundPrefs({ enabled: false })
    expect(SCHEMA_VERSION).toBe(before)
    expect(storage.getItem('drillmcq_schema_version')).toBe(String(before))
  })

  it('is independent of the appearance and theme keys', () => {
    // Muting the app must not touch the look, and an appearance Reset — which
    // rewrites only APPEARANCE_KEY — must not unmute it.
    saveTheme('dark')
    saveAppearance({ font: 'mono', fontScale: 0.9, background: 'contrast' })
    saveSoundPrefs({ enabled: false })

    expect(loadTheme()).toBe('dark')
    expect(loadAppearance().font).toBe('mono')
    expect(loadSoundPrefs().enabled).toBe(false)

    saveAppearance(defaultAppearance())
    expect(loadSoundPrefs().enabled).toBe(false)
  })
})

describe('AI key', () => {
  beforeEach(() => initializeStorage({ database }))

  it('is absent until explicitly saved', () => {
    expect(loadAIKey()).toBeNull()
  })

  it('round-trips and clears', () => {
    saveAIKey('sk-test-123')
    expect(loadAIKey()).toBe('sk-test-123')
    clearAIKey()
    expect(loadAIKey()).toBeNull()
  })

  it('treats an empty stored value as absent', () => {
    storage.setItem(AI_KEY_KEY, '')
    expect(loadAIKey()).toBeNull()
  })

  it('lives in its own key, so clearing it leaves preferences intact', () => {
    saveAIConfig({ ...defaultAIConfig(), enabled: true, provider: 'gemini' })
    saveAIKey('sk-test-123')
    clearAIKey()
    const config = loadAIConfig()
    expect(config.enabled).toBe(true)
    expect(config.provider).toBe('gemini')
  })

  it('never leaks into the preferences entry', () => {
    saveAIConfig({ ...defaultAIConfig(), rememberKey: true })
    saveAIKey('sk-secret-value')
    expect(storage.getItem(AI_PREFS_KEY)).not.toContain('sk-secret-value')
  })

  it('does not throw when storage is full', () => {
    storage.full = true
    expect(() => saveAIKey('sk-test-123')).not.toThrow()
    expect(() => saveAIConfig(defaultAIConfig())).not.toThrow()
  })
})

async function reopen(): Promise<void> {
  const name = database.name
  await closeStorage()
  database = new PouchDB<StoredLearningDocument>(name, { adapter: 'idb' })
  await initializeStorage({ database })
}

const MIGRATION_ID = '_local/learning-localstorage-v1'

describe('database bootstrap and persistence', () => {
  it('does not expose a cache before bootstrap has finished', async () => {
    await database.put({ _id: MIGRATION_ID })
    await database.put({ _id: 'quiz:quiz_1', type: 'quiz', value: makeQuiz(), order: 1 })
    const info = await database.info()
    let release!: (value: PouchDB.Core.DatabaseInfo) => void
    vi.spyOn(database, 'info').mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const first = initializeStorage({ database })
    expect(initializeStorage({ database })).toBe(first)
    expect(() => loadSavedQuizzes()).toThrow('initializeStorage')
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    release(info)
    await first
    expect(loadSavedQuizzes()[0]).toEqual(makeQuiz())
    expect(isStorageAvailable()).toBe(true)
  })

  it('hydrates preexisting quiz, attempt and session documents and skips malformed documents', async () => {
    await database.bulkDocs([
      { _id: 'quiz:quiz_1', type: 'quiz', value: makeQuiz(), order: 1 },
      { _id: 'attempt:attempt_1', type: 'attempt', value: makeAttempt(), order: 2 },
      { _id: 'session:active', type: 'session', value: makeSession(), order: 3 },
      { _id: 'quiz:broken', type: 'quiz', value: { id: 'broken' } },
      { _id: 'quiz:wrong-id', type: 'quiz', value: makeQuiz() },
      { _id: 'unknown', type: 'unknown', value: makeQuiz() },
    ])
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([makeQuiz()])
    expect(loadAttempts()).toEqual([makeAttempt()])
    expect(loadSession()).toEqual(makeSession())
  })

  it('returns synchronous updated arrays and writes individual documents that survive reopening', async () => {
    await initializeStorage({ database })
    expect(upsertSavedQuiz(makeQuiz({ id: 'z' }))).toEqual([makeQuiz({ id: 'z' })])
    upsertSavedQuiz(makeQuiz({ id: 'a' }))
    expect(patchSavedQuiz('z', (quiz) => ({ ...quiz, name: 'Updated' }))[0].name).toBe('Updated')
    expect(appendAttempt(makeAttempt())).toEqual([makeAttempt()])
    appendAttempt(makeAttempt({ percentage: 99 }))
    saveSession(makeSession())
    await flushStorage()
    expect((await database.allDocs()).rows.map((row) => row.id)).toEqual([
      'attempt:attempt_1', 'quiz:a', 'quiz:z', 'session:active',
    ])
    expect((await database.get('attempt:attempt_1')).value).toEqual(makeAttempt())
    await reopen()
    expect(loadSavedQuizzes().map((quiz) => quiz.id)).toEqual(['z', 'a'])
    expect(loadSavedQuizzes()[0].name).toBe('Updated')
    expect(loadAttempts()).toEqual([makeAttempt()])
    expect(loadSession()).toEqual(makeSession())
    expect(storage.getItem(SESSION_KEY)).toBeNull()
    expect(storage.getItem(SAVED_QUIZZES_KEY)).toBeNull()
    expect(storage.getItem(RESULTS_KEY)).toBeNull()
  })

  it('persists cascade deletion and last-attempt reference cleanup across reload', async () => {
    await initializeStorage({ database })
    upsertSavedQuiz(makeQuiz({ lastAttemptId: 'attempt_1' }))
    upsertSavedQuiz(makeQuiz({ id: 'quiz_2', lastAttemptId: 'attempt_2' }))
    appendAttempt(makeAttempt())
    appendAttempt(makeAttempt({ id: 'attempt_2', quizId: 'quiz_2' }))
    saveSession(makeSession())
    await flushStorage()
    expect(deleteAttempt('attempt_2').map((a) => a.id)).toEqual(['attempt_1'])
    expect(loadSavedQuizzes()[1].lastAttemptId).toBeUndefined()
    expect(deleteSavedQuiz('quiz_1').map((quiz) => quiz.id)).toEqual(['quiz_2'])
    clearSession()
    await reopen()
    expect(loadAttempts()).toEqual([])
    expect(loadSavedQuizzes()).toEqual([makeQuiz({ id: 'quiz_2' })])
    expect(loadSession()).toBeNull()
  })

  it('can save a session again after its document has been deleted', async () => {
    await initializeStorage({ database })
    saveSession(makeSession())
    await flushStorage()
    clearSession()
    await flushStorage()
    saveSession(makeSession({ attemptId: 'new-run' }))
    await reopen()
    expect(loadSession()?.attemptId).toBe('new-run')
  })

  it('drains rapid changes in order and keeps snapshots isolated from callers', async () => {
    await initializeStorage({ database })
    const quiz = makeQuiz({ questions: structuredClone(questions) })
    upsertSavedQuiz(quiz)
    quiz.questions[0].question = 'Mutated input'
    const loaded = loadSavedQuizzes()
    loaded[0].questions[0].question = 'Mutated snapshot'
    for (let i = 0; i < 15; i++) {
      saveSession(makeSession({ currentIndex: i % 2 }))
      patchSavedQuiz('quiz_1', (value) => ({ ...value, name: `Revision ${i}` }))
    }
    clearSession()
    await reopen()
    expect(loadSession()).toBeNull()
    expect(loadSavedQuizzes()[0].name).toBe('Revision 14')
    expect(loadSavedQuizzes()[0].questions).toEqual(questions)
  })

  it('retries a revision conflict using the latest document revision', async () => {
    await initializeStorage({ database })
    upsertSavedQuiz(makeQuiz())
    await flushStorage()
    const put = vi.spyOn(database, 'put').mockRejectedValueOnce({ status: 409 })
    patchSavedQuiz('quiz_1', (quiz) => ({ ...quiz, name: 'After conflict' }))
    await flushStorage()
    expect(put).toHaveBeenCalledTimes(2)
    expect((await database.get('quiz:quiz_1')).value).toMatchObject({ name: 'After conflict' })
  })

  it('preserves append order when older quiz updates and new attempts share a timestamp', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(10000)
    await initializeStorage({ database })
    upsertSavedQuiz(makeQuiz())
    appendAttempt(makeAttempt({ id: 'z' }))
    patchSavedQuiz('quiz_1', (quiz) => ({ ...quiz, lastAttemptId: 'z' }))
    appendAttempt(makeAttempt({ id: 'a' }))
    expect(loadAttempts().map((attempt) => attempt.id)).toEqual(['z', 'a'])
    await reopen()
    expect(loadAttempts().map((attempt) => attempt.id)).toEqual(['z', 'a'])
  })

  it('retains failed writes in memory, reports the failure and allows retry', async () => {
    await initializeStorage({ database })
    const listener = vi.fn()
    const unsubscribe = subscribeStorage(listener)
    vi.spyOn(database, 'put').mockRejectedValueOnce({ status: 507 })
    expect(upsertSavedQuiz(makeQuiz())).toHaveLength(1)
    await expect(flushStorage()).rejects.toMatchObject({ status: 507 })
    expect(isStorageAvailable()).toBe(false)
    expect(loadSavedQuizzes()).toEqual([makeQuiz()])
    expect(listener).toHaveBeenCalledWith('status')
    await flushStorage()
    expect(isStorageAvailable()).toBe(true)
    expect((await database.get('quiz:quiz_1')).value).toEqual(makeQuiz())
    unsubscribe()
  })

  it('refreshes cache consumers on database changes without exposing PouchDB to them', async () => {
    await initializeStorage({ database })
    const listener = vi.fn()
    const unsubscribe = subscribeStorage(listener)
    await database.put({ _id: 'quiz:quiz_1', type: 'quiz', value: makeQuiz() })
    await database.put({ _id: 'session:active', type: 'session', value: makeSession() })
    await vi.waitFor(() => {
      expect(loadSavedQuizzes()).toEqual([makeQuiz()])
      expect(loadSession()).toEqual(makeSession())
    })
    expect(listener).toHaveBeenCalledWith('quiz')
    await database.remove(await database.get('quiz:quiz_1'))
    await vi.waitFor(() => expect(loadSavedQuizzes()).toEqual([]))
    unsubscribe()
  })
})

describe('one-time learning-data import', () => {
  function seedLegacy(): void {
    storage.setItem(SAVED_QUIZZES_KEY, JSON.stringify([makeQuiz(), makeQuiz()]))
    storage.setItem(RESULTS_KEY, JSON.stringify([makeAttempt(), makeAttempt()]))
    storage.setItem(SESSION_KEY, JSON.stringify(makeSession()))
  }

  it('imports all learning data once, preserves original keys, and never resurrects deleted records', async () => {
    seedLegacy()
    const originals = [SAVED_QUIZZES_KEY, RESULTS_KEY, SESSION_KEY].map((key) => storage.getItem(key))
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([makeQuiz()])
    expect(loadAttempts()).toEqual([makeAttempt()])
    expect(loadSession()).toEqual(makeSession())
    expect((await database.get(MIGRATION_ID))._id).toBe(MIGRATION_ID)
    await reopen()
    expect(loadSavedQuizzes()).toHaveLength(1)
    expect(loadAttempts()).toHaveLength(1)
    deleteSavedQuiz('quiz_1')
    clearSession()
    await reopen()
    expect(loadSavedQuizzes()).toEqual([])
    expect(loadAttempts()).toEqual([])
    expect(loadSession()).toBeNull()
    expect([SAVED_QUIZZES_KEY, RESULTS_KEY, SESSION_KEY].map((key) => storage.getItem(key))).toEqual(originals)
  })

  it('recovers from an interrupted import without replacing already imported data', async () => {
    seedLegacy()
    const put = database.put.bind(database)
    vi.spyOn(database, 'put').mockImplementation(async (document) => {
      if (document._id === 'attempt:attempt_1') throw { status: 507 }
      return put(document)
    })
    await expect(initializeStorage({ database })).rejects.toMatchObject({ status: 507 })
    expect(() => loadSavedQuizzes()).toThrow('initializeStorage')
    database = new PouchDB<StoredLearningDocument>(database.name, { adapter: 'idb' })
    await expect(database.get(MIGRATION_ID)).rejects.toMatchObject({ status: 404 })
    const existing = await database.get('quiz:quiz_1')
    await database.put({ ...existing, value: makeQuiz({ name: 'Already updated' }) })
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([makeQuiz({ name: 'Already updated' })])
    expect(loadAttempts()).toEqual([makeAttempt()])
    expect(loadSession()).toEqual(makeSession())
  })

  it('does not reimport tombstones if the migration marker was not committed', async () => {
    seedLegacy()
    await database.put({ _id: 'quiz:quiz_1', type: 'quiz', value: makeQuiz() })
    await database.remove(await database.get('quiz:quiz_1'))
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([])
  })

  it('leaves malformed arrays and sessions intact while starting cleanly', async () => {
    storage.setItem(SAVED_QUIZZES_KEY, '{broken')
    storage.setItem(RESULTS_KEY, '[null, {}, "bad"]')
    storage.setItem(SESSION_KEY, '[]')
    await initializeStorage({ database })
    expect(loadSavedQuizzes()).toEqual([])
    expect(loadAttempts()).toEqual([])
    expect(loadSession()).toBeNull()
    expect(storage.getItem(SAVED_QUIZZES_KEY)).toBe('{broken')
  })

  it('defers the migration marker while localStorage is blocked', async () => {
    installBlockedStorage()
    await initializeStorage({ database })
    await expect(database.get(MIGRATION_ID)).rejects.toMatchObject({ status: 404 })
    upsertSavedQuiz(makeQuiz({ name: 'New IndexedDB quiz' }))
    storage = installMemoryStorage()
    seedLegacy()
    await reopen()
    expect(loadSavedQuizzes()[0].name).toBe('New IndexedDB quiz')
    expect(loadAttempts()).toEqual([makeAttempt()])
  })

  it('keeps all device preferences and the remembered AI key outside PouchDB', async () => {
    seedLegacy()
    saveTheme('dark')
    saveAppearance({ font: 'serif', fontScale: 1.1, background: 'warm' })
    saveSoundPrefs({ enabled: false })
    await initializeStorage({ database })
    saveAIConfig({ ...defaultAIConfig(), rememberKey: true })
    saveAIKey('test-only-device-secret')
    await flushStorage()
    const documents = await database.allDocs({ include_docs: true })
    expect(documents.rows.map((row) => row.id)).toEqual(['attempt:attempt_1', 'quiz:quiz_1', 'session:active'])
    const serialized = JSON.stringify(documents)
    for (const key of [AI_KEY_KEY, AI_PREFS_KEY, APPEARANCE_KEY, SOUND_KEY, 'drillmcq.theme.v1', 'test-only-device-secret']) {
      expect(serialized).not.toContain(key)
    }
    expect(loadAIKey()).toBe('test-only-device-secret')
    expect(loadTheme()).toBe('dark')
    expect(loadSoundPrefs()).toEqual({ enabled: false })
  })
})

describe('optional native synchronization', () => {
  it('does not start remote sync without a URL', async () => {
    const sync = vi.spyOn(database, 'sync')
    await initializeStorage({ database, remoteUrl: '  ' })
    expect(sync).not.toHaveBeenCalled()
    expect(upsertSavedQuiz(makeQuiz())).toEqual([makeQuiz()])
    await flushStorage()
  })

  it('resolves a reverse-proxy path and keeps persisting locally if sync cannot start', async () => {
    vi.stubGlobal('location', { href: 'https://example.test/quiz/' })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sync = vi.spyOn(database, 'sync').mockImplementation(() => { throw new Error('offline') })
    await initializeStorage({ database, remoteUrl: '/couchdb/my/' })
    expect(sync).toHaveBeenCalledWith(expect.objectContaining({ name: 'https://example.test/couchdb/my/' }), {
      live: true, retry: true,
    })
    expect(upsertSavedQuiz(makeQuiz())).toEqual([makeQuiz()])
    // No explicit flush is needed in the app; the synchronous write schedules it.
    await vi.waitFor(async () => expect((await database.get('quiz:quiz_1')).value).toEqual(makeQuiz()))
    expect(isStorageAvailable()).toBe(true)
  })

  it('configures live retrying sync while preserving synchronous calls and refreshing replicated data', async () => {
    const peer = new PouchDB<StoredLearningDocument>(`peer-test-${crypto.randomUUID()}`, { adapter: 'idb' })
    // Exercise native replication against a local peer in place of HTTP.
    const replication = database.sync(peer, { live: true, retry: true })
    const sync = vi.spyOn(database, 'sync').mockReturnValue(replication)
    try {
      await initializeStorage({ database, remoteUrl: 'https://example.test/couchdb/my/' })
      saveAIKey('test-only-device-secret')
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ name: 'https://example.test/couchdb/my/' }), {
        live: true, retry: true,
      })
      expect(upsertSavedQuiz(makeQuiz())).toEqual([makeQuiz()])
      await flushStorage()
      await vi.waitFor(async () => expect((await peer.get('quiz:quiz_1')).value).toEqual(makeQuiz()))
      await peer.put({ _id: 'attempt:attempt_1', type: 'attempt', value: makeAttempt() })
      await vi.waitFor(() => expect(loadAttempts()).toEqual([makeAttempt()]))
      await expect(peer.get(MIGRATION_ID)).rejects.toMatchObject({ status: 404 })
      expect(JSON.stringify(await peer.allDocs({ include_docs: true }))).not.toContain('test-only-device-secret')
    } finally {
      await closeStorage()
      replication.cancel()
      await peer.destroy()
    }
  })

  it('ignores invalid or credential-bearing endpoints without exposing them or blocking local mode', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const sync = vi.spyOn(database, 'sync')
    await initializeStorage({ database, remoteUrl: 'https://user:test-only-secret@example.test/learning' })
    expect(sync).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-only-secret')
    expect(upsertSavedQuiz(makeQuiz())).toEqual([makeQuiz()])
    await flushStorage()
  })
})
