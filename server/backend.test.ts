import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createBackend } from './createBackend.js'
import type { AttemptUpdate } from './domain/attempts.js'
import { DomainError } from './domain/errors.js'
import { gradeAttempt } from './domain/grading.js'
import type { QuizDefinition, UserQuiz } from './domain/quizzes.js'
import type { StartAttemptInput } from './services/AttemptService.js'
import { CouchDbClient } from './storage/couchdb/CouchDbClient.js'
import { databases, userDatabaseName } from './storage/databaseNames.js'
import { MemoryDocumentStore } from './storage/memory/MemoryDocumentStore.js'
import type { DocumentStore } from './storage/DocumentStore.js'
import { FakeCouch } from './test/FakeCouch.js'
import { admin, alice, bob, key, publishInput, quiz, quizRef, user } from './test/fixtures.js'

function expectNoKey(value: unknown): void {
  if (!value || typeof value !== 'object') return
  for (const [field, child] of Object.entries(value)) {
    expect(['correctAnswers', 'correctAnswer', 'answerKey', 'explanation']).not.toContain(field)
    expectNoKey(child)
  }
}

describe.each(['memory', 'couch-http'] as const)('%s repository/service contract', adapter => {
  let store: DocumentStore
  let backend: ReturnType<typeof createBackend>
  let time: number

  beforeEach(async () => {
    time = 10_000
    store = adapter === 'memory' ? new MemoryDocumentStore()
      : new CouchDbClient({ url: 'http://couch.test:5984', username: 'backend', password: 'test-secret' }, new FakeCouch().fetch)
    backend = createBackend(store, { now: () => time })
    await backend.initialize()
    await backend.repositories.users.create(user(admin, 'admin'))
    await backend.repositories.users.create(user(alice, 'alice'))
    await backend.repositories.users.create(user(bob, 'bob'))
    await backend.services.quizzes.publishQuiz(admin, publishInput())
  })

  it('isolates attempts in service and repository, including from another admin', async () => {
    const attempt = await backend.services.attempts.startAttempt(bob, { quizRef })
    expect(await backend.services.attempts.listAttempts(alice)).toEqual([])
    for (const principal of [alice, admin]) {
      expect(await backend.repositories.attempts.get(principal, attempt.id)).toBeUndefined()
      await expect(backend.services.attempts.getAttempt(principal, attempt.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(backend.services.attempts.updateAttempt(principal, attempt.id, { answers: { 1: ['A'] } })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(backend.services.attempts.finishAttempt(principal, attempt.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(backend.services.attempts.abandonAttempt(principal, attempt.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }
    await expect(backend.repositories.attempts.create(alice, attempt)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(await backend.services.attempts.listAttempts(bob)).toEqual([attempt])
  })

  it('rejects client-selected owners, database names, results, presentation and timing', async () => {
    for (const extra of [{ userId: bob.userId }, { database: databases.catalog }, { result: { percentage: 100 } }]) {
      await expect(backend.services.attempts.startAttempt(alice, { quizRef, ...extra } as StartAttemptInput)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    for (const extra of [{ userId: bob.userId }, { result: { percentage: 100 } }, { status: 'completed' },
      { settings: { passPercentage: 0 } }, { completedAt: 0 }, { presentation: { questionOrder: [1] } }, { revealed: [1] }]) {
      await expect(backend.services.attempts.updateAttempt(alice, attempt.id, extra as AttemptUpdate)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
  })

  it('projects every public quiz DTO and persisted catalog without answer keys, even from polluted inputs', async () => {
    const polluted = publishInput()
    polluted.version = 2
    Object.assign(polluted.questions[0], { correctAnswers: ['A'], explanation: 'leak', answerKey: key })
    const created = await backend.services.quizzes.publishQuiz(admin, polluted)
    expectNoKey(created)
    expectNoKey(await backend.services.quizzes.getQuiz(alice, quiz.id, 2))
    expectNoKey(await backend.services.quizzes.listQuizzes(alice))
    expectNoKey(await store.list(databases.catalog, 'quiz:'))
    expect(await backend.repositories.quizzes.getAnswerKey(quiz.id, 2)).toMatchObject({ answers: key.answers })
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    expectNoKey(attempt)
    expectNoKey(await backend.services.attempts.finishAttempt(alice, attempt.id))
    // Defensive projection also applies when a replacement repository returns overbroad objects.
    vi.spyOn(backend.repositories.quizzes, 'getPublished').mockResolvedValue(Object.assign(structuredClone(quiz), { answerKey: key }))
    expectNoKey(await backend.services.quizzes.getQuiz(alice, quiz.id, 1))
  })

  it('completes with server grading and server time, ignores drafts and makes repeated finish immutable', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef, settings: { passPercentage: 67 } })
    await backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 1: ['A'] }, drafts: { 3: ['Yes'] } })
    await backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 2: ['C', 'A'] }, currentIndex: 2 })
    time += 5_500
    const completed = await backend.services.attempts.finishAttempt(alice, attempt.id)
    expect(completed).toMatchObject({ status: 'completed', userId: alice.userId, quizRef, completedAt: time, drafts: {},
      result: { correct: 2, incorrect: 0, unanswered: 1, total: 3, percentage: 67, passed: true, timeTakenSeconds: 5 } })
    time += 99_000
    expect(await backend.services.attempts.finishAttempt(alice, attempt.id)).toEqual(completed)
    expect(await backend.services.attempts.listAttempts(alice)).toEqual([completed])
    await expect(backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 3: ['Yes'] } })).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(backend.services.attempts.abandonAttempt(alice, attempt.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    const saved = (await backend.repositories.attempts.get(alice, attempt.id))!
    await expect(backend.repositories.attempts.replace(alice, { ...completed, answers: {} }, saved.revision)).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('makes simultaneous finish calls converge to one result', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    const results = await Promise.all(Array.from({ length: 4 }, () => backend.services.attempts.finishAttempt(alice, attempt.id)))
    results.forEach(result => expect(result).toEqual(results[0]))
    expect(await backend.services.attempts.listAttempts(alice)).toHaveLength(1)
  })

  it('regrades latest answers when an update wins the race against finish', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    const replace = backend.repositories.attempts.replace.bind(backend.repositories.attempts)
    vi.spyOn(backend.repositories.attempts, 'replace').mockImplementationOnce(async () => {
      const current = (await backend.repositories.attempts.get(alice, attempt.id))!
      await replace(alice, { ...current.value, answers: { 1: ['A'] } }, current.revision)
      throw new DomainError('CONFLICT', 'Concurrent update')
    })
    expect((await backend.services.attempts.finishAttempt(alice, attempt.id)).result).toMatchObject({ correct: 1, unanswered: 2 })
  })

  it('rejects stale writes instead of losing newer answers', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    const stale = (await backend.repositories.attempts.get(alice, attempt.id))!
    await backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 1: ['A'] } })
    await expect(backend.repositories.attempts.replace(alice, { ...stale.value, answers: { 2: ['B'] } }, stale.revision)).rejects.toMatchObject({ code: 'CONFLICT' })
    expect((await backend.services.attempts.getAttempt(alice, attempt.id)).answers).toEqual({ 1: ['A'] })
  })

  it('keeps version 1 reproducible after a different version 2 is published', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    await backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 1: ['A'] } })
    const second = publishInput()
    second.version = 2
    second.answers[0].correctAnswers = ['B']
    await backend.services.quizzes.publishQuiz(admin, second)
    const completed = await backend.services.attempts.finishAttempt(alice, attempt.id)
    expect(completed.quizRef.version).toBe(1)
    expect(completed.result?.correct).toBe(1)
    expect(gradeAttempt((await backend.repositories.quizzes.getPublished(quiz.id, 1))!,
      (await backend.repositories.quizzes.getAnswerKey(quiz.id, 1))!, completed.answers, completed.settings)).toMatchObject({ correct: 1 })
    await expect(backend.services.quizzes.publishQuiz(admin, publishInput())).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(backend.repositories.quizzes.publish(quiz, { ...key, answers: second.answers })).rejects.toMatchObject({ code: 'CONFLICT' })
    expect(await backend.repositories.quizzes.getAnswerKey(quiz.id, 1)).toEqual(key)
  })

  it('stores category selection and server-generated presentation for resume', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef,
      settings: { categories: ['multi'], shuffleQuestions: true, shuffleOptions: true } })
    expect(attempt.presentation.questionOrder).toEqual([2])
    expect(attempt.presentation.optionOrder[2].toSorted()).toEqual(['A', 'B', 'C'])
    expect((await backend.services.attempts.getAttempt(alice, attempt.id)).presentation).toEqual(attempt.presentation)
    await expect(backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 1: ['A'] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await backend.services.attempts.updateAttempt(alice, attempt.id, { answers: { 2: ['A', 'C'] } })
    expect((await backend.services.attempts.finishAttempt(alice, attempt.id)).result).toMatchObject({ total: 1, percentage: 100 })
    await expect(backend.services.attempts.startAttempt(alice, { quizRef, settings: { categories: ['missing'] } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('rejects invalid answers, settings and navigation before persisting', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    for (const input of [{ answers: { 999: ['A'] } }, { answers: { 1: ['X'] } }, { answers: { 2: ['A', 'A'] } },
      { currentIndex: -1 }, { currentIndex: 3 }, { drafts: { 1: ['X'] } }] as AttemptUpdate[]) {
      await expect(backend.services.attempts.updateAttempt(alice, attempt.id, input)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    for (const settings of [{ timerMinutes: -1 }, { passPercentage: 101 }, { passPercentage: NaN }]) {
      await expect(backend.services.attempts.startAttempt(alice, { quizRef, settings })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    }
    expect(await backend.services.attempts.getAttempt(alice, attempt.id)).toEqual(attempt)
  })

  it('supports abandonment without creating a result', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    const abandoned = await backend.services.attempts.abandonAttempt(alice, attempt.id)
    expect(abandoned.status).toBe('abandoned')
    expect(abandoned.result).toBeUndefined()
    expect(await backend.services.attempts.abandonAttempt(alice, attempt.id)).toEqual(abandoned)
    await expect(backend.services.attempts.finishAttempt(alice, attempt.id)).rejects.toMatchObject({ code: 'INVALID_STATE' })
    await expect(backend.services.attempts.updateAttempt(alice, attempt.id, {})).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('defaults identity to unconfigured and leaderboard privacy to opt-out, reserves normalized logins', async () => {
    const created = await backend.services.users.createUser(admin, { login: ' David ', displayName: 'David' })
    expect(created).toMatchObject({ login: 'david', role: 'student', status: 'active', leaderboard: { optIn: false } })
    expect(created).not.toHaveProperty('auth')
    expect((await backend.repositories.users.getById(created.id))?.value.auth).toEqual({ type: 'unconfigured' })
    expect((await backend.repositories.users.getByLogin('DAVID'))?.value.id).toBe(created.id)
    const competing = await Promise.allSettled([
      backend.services.users.createUser(admin, { login: 'same', displayName: 'First' }),
      backend.services.users.createUser(admin, { login: 'SAME', displayName: 'Second' }),
    ])
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'CONFLICT' } })
    const identity = (await backend.repositories.users.getById(created.id))!
    await backend.repositories.users.replace({ ...identity.value, auth: { type: 'password', passwordHash: 'future-hash' } }, identity.revision)
    expect(await backend.services.users.getCurrentUser({ userId: created.id, role: 'student' })).not.toHaveProperty('auth')
  })

  it('requires a registry-backed admin role and rejects disabled principals', async () => {
    for (const principal of [alice, { ...alice, role: 'admin' } as const]) {
      await expect(backend.services.users.createUser(principal, { login: 'new', displayName: 'New' })).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(backend.services.users.disableUser(principal, bob.userId)).rejects.toMatchObject({ code: 'FORBIDDEN' })
      await expect(backend.services.quizzes.publishQuiz(principal, { ...publishInput(), version: 2 })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    }
    await backend.services.users.disableUser(admin, alice.userId)
    await expect(backend.services.attempts.listAttempts(alice)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(backend.services.attempts.startAttempt(alice, { quizRef })).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(backend.services.quizzes.listQuizzes(alice)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('gates every user-quiz service operation and user-scope attempts by default', async () => {
    expect(backend.features.userQuizzesEnabled).toBe(false)
    for (const operation of [
      backend.services.userQuizzes.createQuiz(alice, publishInput()),
      backend.services.userQuizzes.publishQuiz(alice),
      backend.services.userQuizzes.getQuiz(alice, quiz.id, 1),
      backend.services.userQuizzes.listQuizzes(alice),
      backend.services.attempts.startAttempt(alice, { quizRef: { ...quizRef, scope: 'user' } }),
    ]) await expect(operation).rejects.toMatchObject({ code: 'FEATURE_DISABLED' })
  })

  it('stores private content and keys separately and isolates even identical quiz IDs', async () => {
    const privateQuiz: UserQuiz = { ...quiz, publishedAt: undefined, source: { type: 'user', ownerUserId: bob.userId }, status: 'private' }
    await backend.repositories.userQuizzes.create(bob, privateQuiz, key)
    expect(await backend.repositories.userQuizzes.get(alice, quiz.id, 1)).toBeUndefined()
    expect(await backend.repositories.userQuizzes.getAnswerKey(alice, quiz.id, 1)).toBeUndefined()
    expect(await backend.repositories.userQuizzes.list(alice)).toEqual([])
    await expect(backend.repositories.userQuizzes.create(alice, privateQuiz, key)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expectNoKey(await backend.repositories.userQuizzes.get(bob, quiz.id, 1))
    expectNoKey(await store.list(userDatabaseName(bob.userId), 'user-quiz:'))
    expect(await backend.repositories.userQuizzes.getAnswerKey(bob, quiz.id, 1)).toEqual(key)
    await backend.repositories.userQuizzes.create(alice, { ...privateQuiz, source: { type: 'user', ownerUserId: alice.userId } },
      { ...key, answers: [{ ...key.answers[0], correctAnswers: ['B'] }, ...key.answers.slice(1)] })
    expect((await backend.repositories.userQuizzes.getAnswerKey(bob, quiz.id, 1))?.answers[0].correctAnswers).toEqual(['A'])
  })

  it('keeps all future enabled user-quiz DTOs safe and never enables publishing', async () => {
    const future = createBackend(store, { features: { userQuizzesEnabled: true } })
    const input = publishInput()
    Object.assign(input.questions[0], { correctAnswers: ['A'], explanation: 'secret' })
    expectNoKey(await future.services.userQuizzes.createQuiz(alice, input))
    expectNoKey(await future.services.userQuizzes.listQuizzes(alice))
    expectNoKey(await future.services.userQuizzes.getQuiz(alice, quiz.id, 1))
    await expect(future.services.userQuizzes.publishQuiz(alice)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
    await expect(future.services.userQuizzes.getQuiz(bob, quiz.id, 1)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('does not expose half-published versions and safely retries a matching orphan key', async () => {
    const create = store.create.bind(store)
    vi.spyOn(store, 'create').mockImplementation(async (database, id, document) => {
      if (database === databases.catalog) throw new DomainError('STORAGE_ERROR', 'Injected catalog failure')
      return create(database, id, document)
    })
    await expect(backend.services.quizzes.publishQuiz(admin, { ...publishInput(), version: 2 })).rejects.toMatchObject({ code: 'STORAGE_ERROR' })
    expect(await backend.repositories.quizzes.getPublished(quiz.id, 2)).toBeUndefined()
    vi.mocked(store.create).mockRestore()
    const changed = { ...publishInput(), version: 2, name: 'Different content' }
    await expect(backend.services.quizzes.publishQuiz(admin, changed)).rejects.toMatchObject({ code: 'CONFLICT' })
    time += 10_000
    await backend.services.quizzes.publishQuiz(admin, { ...publishInput(), version: 2 })
    expect(await backend.repositories.quizzes.getPublished(quiz.id, 2)).toMatchObject({ version: 2, publishedAt: time })
  })

  it('clones stored values so returned data cannot mutate persistence', async () => {
    const attempt = await backend.services.attempts.startAttempt(alice, { quizRef })
    attempt.answers[1] = ['B']
    expect((await backend.services.attempts.getAttempt(alice, attempt.id)).answers).toEqual({})
    const returned = await backend.services.quizzes.getQuiz(alice, quiz.id, 1)
    returned.questions[0].options.push('Bad')
    expect((await backend.services.quizzes.getQuiz(alice, quiz.id, 1)).questions[0].options).toEqual(['A', 'B', 'C'])
  })

  it('rejects malformed quiz content and keys before publishing', async () => {
    const cases = [
      { ...quiz, id: '../../catalog' }, { ...quiz, version: 0 },
      { ...quiz, questions: [] }, { ...quiz, questions: [quiz.questions[0], quiz.questions[0]] },
      { ...quiz, questions: [{ ...quiz.questions[0], options: ['A', 'A'] }, ...quiz.questions.slice(1)] },
    ] as QuizDefinition[]
    for (const invalid of cases) await expect(backend.repositories.quizzes.publish(invalid, key)).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })
})
