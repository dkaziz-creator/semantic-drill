import { randomInt, randomUUID } from 'node:crypto'
import type { ServerFeatures } from '../config/features.js'
import { parseSettings, selectedQuestions, validateSelections } from '../domain/attempts.js'
import type { Attempt, AttemptSettings, AttemptUpdate } from '../domain/attempts.js'
import { DomainError, requireCondition } from '../domain/errors.js'
import { gradeAttempt } from '../domain/grading.js'
import type { QuizDefinition } from '../domain/quizzes.js'
import type { Principal } from '../domain/users.js'
import { onlyKeys } from '../domain/validation.js'
import type { AttemptRepository } from '../repositories/AttemptRepository.js'
import type { QuizRepository } from '../repositories/QuizRepository.js'
import type { UserQuizRepository } from '../repositories/UserQuizRepository.js'
import type { AuthorizationService } from './AuthorizationService.js'

export interface StartAttemptInput {
  quizRef: Attempt['quizRef']
  settings?: Partial<AttemptSettings>
}

function shuffled<T>(values: T[], enabled: boolean): T[] {
  const copy = [...values]
  if (enabled) {
    for (let index = copy.length - 1; index > 0; index--) {
      const other = randomInt(index + 1)
      ;[copy[index], copy[other]] = [copy[other], copy[index]]
    }
  }
  return copy
}

export class AttemptService {
  constructor(
    private readonly attempts: AttemptRepository,
    private readonly quizzes: QuizRepository,
    private readonly userQuizzes: UserQuizRepository,
    private readonly authorization: AuthorizationService,
    private readonly features: ServerFeatures,
    private readonly now: () => number = Date.now,
  ) {}

  private async quiz(principal: Principal, ref: Attempt['quizRef']): Promise<QuizDefinition> {
    onlyKeys(ref, ['scope', 'quizId', 'version'])
    requireCondition(ref.scope === 'catalog' || ref.scope === 'user', 'Invalid quiz scope')
    if (ref.scope === 'user' && !this.features.userQuizzesEnabled) {
      throw new DomainError('FEATURE_DISABLED', 'User quizzes are disabled')
    }
    const quiz = ref.scope === 'catalog' ? await this.quizzes.getPublished(ref.quizId, ref.version)
      : await this.userQuizzes.get(principal, ref.quizId, ref.version)
    if (!quiz) throw new DomainError('NOT_FOUND', 'Quiz not found')
    return quiz
  }

  private async stored(principal: Principal, attemptId: string) {
    const stored = await this.attempts.get(principal, attemptId)
    if (!stored) throw new DomainError('NOT_FOUND', 'Attempt not found')
    return stored
  }

  async listAttempts(principal: Principal): Promise<Attempt[]> {
    await this.authorization.requireActive(principal)
    return this.attempts.list(principal)
  }

  async getAttempt(principal: Principal, attemptId: string): Promise<Attempt> {
    await this.authorization.requireActive(principal)
    return (await this.stored(principal, attemptId)).value
  }

  async startAttempt(principal: Principal, input: StartAttemptInput): Promise<Attempt> {
    await this.authorization.requireActive(principal)
    onlyKeys(input, ['quizRef', 'settings'])
    const quiz = await this.quiz(principal, input.quizRef)
    const settings = parseSettings(input.settings)
    const questions = selectedQuestions(quiz, settings)
    requireCondition(questions.length > 0, 'No questions match the selected categories')
    const now = this.now()
    const attempt: Attempt = {
      id: randomUUID(), userId: principal.userId,
      quizRef: { scope: input.quizRef.scope, quizId: quiz.id, version: quiz.version },
      status: 'active', startedAt: now, updatedAt: now, currentIndex: 0,
      answers: {}, drafts: {}, revealed: [], settings,
      presentation: {
        questionOrder: shuffled(questions.map(question => question.id), settings.shuffleQuestions),
        optionOrder: Object.fromEntries(questions.map(question => [question.id, shuffled(question.options, settings.shuffleOptions)])),
      },
    }
    await this.attempts.create(principal, attempt)
    return attempt
  }

  async updateAttempt(principal: Principal, attemptId: string, input: AttemptUpdate): Promise<Attempt> {
    await this.authorization.requireActive(principal)
    onlyKeys(input, ['currentIndex', 'answers', 'drafts'])
    const previous = await this.stored(principal, attemptId)
    if (previous.value.status !== 'active') throw new DomainError('INVALID_STATE', 'Attempt is no longer active')
    const quiz = await this.quiz(principal, previous.value.quizRef)
    const questions = selectedQuestions(quiz, previous.value.settings)
    const next = structuredClone(previous.value)
    if (input.currentIndex !== undefined) {
      requireCondition(Number.isInteger(input.currentIndex) && input.currentIndex >= 0
        && input.currentIndex < questions.length, 'Invalid current question index')
      next.currentIndex = input.currentIndex
    }
    // Maps are patches: unmentioned questions retain their previous selections.
    for (const field of ['answers', 'drafts'] as const) {
      if (input[field] !== undefined) {
        validateSelections(questions, input[field])
        next[field] = { ...next[field], ...structuredClone(input[field]) }
      }
    }
    next.updatedAt = Math.max(this.now(), previous.value.updatedAt)
    await this.attempts.replace(principal, next, previous.revision)
    return next
  }

  async finishAttempt(principal: Principal, attemptId: string): Promise<Attempt> {
    await this.authorization.requireActive(principal)
    // Reload and regrade authoritative state on conflict, never reuse a stale result.
    for (let retries = 0; retries < 5; retries++) {
      const previous = await this.stored(principal, attemptId)
      const attempt = previous.value
      if (attempt.status === 'completed') return attempt
      if (attempt.status !== 'active') throw new DomainError('INVALID_STATE', 'Abandoned attempt cannot be completed')
      const quiz = await this.quiz(principal, attempt.quizRef)
      const key = attempt.quizRef.scope === 'catalog'
        ? await this.quizzes.getAnswerKey(quiz.id, quiz.version)
        : await this.userQuizzes.getAnswerKey(principal, quiz.id, quiz.version)
      if (!key) throw new DomainError('STORAGE_ERROR', 'Published quiz answer key is missing')
      const completedAt = Math.max(this.now(), attempt.updatedAt, attempt.startedAt)
      const next: Attempt = {
        ...attempt, status: 'completed', updatedAt: completedAt, completedAt, drafts: {},
        result: {
          ...gradeAttempt(quiz, key, attempt.answers, attempt.settings),
          timeTakenSeconds: Math.floor((completedAt - attempt.startedAt) / 1000),
        },
      }
      try {
        await this.attempts.replace(principal, next, previous.revision)
        return next
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'CONFLICT') throw error
      }
    }
    throw new DomainError('CONFLICT', 'Attempt is being updated; retry finish')
  }

  async abandonAttempt(principal: Principal, attemptId: string): Promise<Attempt> {
    await this.authorization.requireActive(principal)
    const previous = await this.stored(principal, attemptId)
    if (previous.value.status === 'abandoned') return previous.value
    if (previous.value.status !== 'active') throw new DomainError('INVALID_STATE', 'Completed attempt is immutable')
    const next: Attempt = { ...previous.value, status: 'abandoned', updatedAt: Math.max(this.now(), previous.value.updatedAt) }
    await this.attempts.replace(principal, next, previous.revision)
    return next
  }
}
