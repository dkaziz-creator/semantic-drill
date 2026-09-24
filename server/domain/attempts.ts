import { isDeepStrictEqual } from 'node:util'
import { DomainError, requireCondition } from './errors.js'
import type { PublicQuizQuestion, QuizDefinition } from './quizzes.js'
import { onlyKeys, record, uniqueStrings } from './validation.js'

export interface AttemptSettings {
  shuffleQuestions: boolean
  shuffleOptions: boolean
  timerMinutes: number
  categories: string[]
  passPercentage: number
}

export interface Grade {
  correct: number
  incorrect: number
  unanswered: number
  total: number
  percentage: number
  passed: boolean
}

export interface Attempt {
  id: string
  userId: string
  quizRef: { scope: 'catalog' | 'user'; quizId: string; version: number }
  status: 'active' | 'completed' | 'abandoned'
  startedAt: number
  updatedAt: number
  completedAt?: number
  currentIndex: number
  answers: Record<number, string[]>
  drafts: Record<number, string[]>
  revealed: number[]
  settings: AttemptSettings
  presentation: { questionOrder: number[]; optionOrder: Record<number, string[]> }
  result?: Grade & { timeTakenSeconds: number }
}

export interface AttemptUpdate {
  currentIndex?: number
  answers?: Record<number, string[]>
  drafts?: Record<number, string[]>
}

export function parseSettings(input: Partial<AttemptSettings> = {}): AttemptSettings {
  onlyKeys(input, ['shuffleQuestions', 'shuffleOptions', 'timerMinutes', 'categories', 'passPercentage'])
  const settings = {
    shuffleQuestions: input.shuffleQuestions ?? false,
    shuffleOptions: input.shuffleOptions ?? false,
    timerMinutes: input.timerMinutes ?? 0,
    categories: input.categories ?? [],
    passPercentage: input.passPercentage ?? 70,
  }
  requireCondition(typeof settings.shuffleQuestions === 'boolean' && typeof settings.shuffleOptions === 'boolean', 'Invalid shuffle setting')
  requireCondition(Number.isFinite(settings.timerMinutes) && settings.timerMinutes >= 0, 'Invalid timer')
  requireCondition(Number.isInteger(settings.passPercentage) && settings.passPercentage >= 0 && settings.passPercentage <= 100, 'Invalid pass percentage')
  uniqueStrings(settings.categories)
  return { ...settings, categories: [...settings.categories] }
}

export function selectedQuestions(quiz: QuizDefinition, settings: Pick<AttemptSettings, 'categories'>): PublicQuizQuestion[] {
  return quiz.questions.filter(question => settings.categories.length === 0
    || (question.category !== undefined && settings.categories.includes(question.category)))
}

export function validateSelections(questions: PublicQuizQuestion[], selections: Record<number, string[]>): void {
  record(selections)
  for (const [id, options] of Object.entries(selections)) {
    const question = questions.find(question => String(question.id) === id)
    requireCondition(question, 'Selection refers to a question outside this attempt')
    uniqueStrings(options)
    requireCondition(options.every(option => question.options.includes(option)), 'Unknown selected option')
  }
}

export function assertAttemptTransition(previous: Attempt, next: Attempt): void {
  if (previous.status !== 'active') throw new DomainError('INVALID_STATE', 'A terminal attempt is immutable')
  for (const field of ['id', 'userId', 'quizRef', 'startedAt', 'settings', 'presentation'] as const) {
    requireCondition(isDeepStrictEqual(previous[field], next[field]), `Attempt ${field} is immutable`)
  }
  requireCondition(['active', 'completed', 'abandoned'].includes(next.status), 'Invalid attempt status')
  requireCondition(next.updatedAt >= previous.updatedAt, 'Attempt time cannot move backwards')
  requireCondition(next.status === 'completed'
    ? next.result !== undefined && next.completedAt === next.updatedAt
    : next.result === undefined && next.completedAt === undefined, 'Invalid completion data')
}
