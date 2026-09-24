import { requireCondition } from './errors.js'
import { assertQuizId, assertUserId, nonemptyString, optionalString, positiveInteger, record, timestamp, uniqueStrings } from './validation.js'

export interface PublicQuizQuestion {
  id: number
  question: string
  options: string[]
  category?: string
  difficulty?: string
}

export interface QuizAnswer {
  questionId: number
  correctAnswers: string[]
  explanation?: string
}

export interface QuizDefinition {
  id: string
  version: number
  name: string
  description?: string
  source: { type: 'admin' } | { type: 'user'; ownerUserId: string }
  questions: PublicQuizQuestion[]
  createdAt: number
  publishedAt?: number
}

export interface QuizAnswerKey {
  quizId: string
  version: number
  answers: QuizAnswer[]
}

export type UserQuizStatus = 'draft' | 'private' | 'pending-review'
export interface UserQuiz extends QuizDefinition {
  source: { type: 'user'; ownerUserId: string }
  status: UserQuizStatus
}

// Explicit projection is intentional: TypeScript alone does not strip extra JSON fields.
export function publicQuiz(quiz: QuizDefinition): QuizDefinition {
  return {
    id: quiz.id, version: quiz.version, name: quiz.name,
    ...(quiz.description === undefined ? {} : { description: quiz.description }),
    source: quiz.source.type === 'admin' ? { type: 'admin' }
      : { type: 'user', ownerUserId: quiz.source.ownerUserId },
    questions: quiz.questions.map(question => ({
      id: question.id, question: question.question, options: [...question.options],
      ...(question.category === undefined ? {} : { category: question.category }),
      ...(question.difficulty === undefined ? {} : { difficulty: question.difficulty }),
    })),
    createdAt: quiz.createdAt,
    ...(quiz.publishedAt === undefined ? {} : { publishedAt: quiz.publishedAt }),
  }
}

export function privateQuiz(quiz: UserQuiz): UserQuiz {
  return { ...publicQuiz(quiz), source: { type: 'user', ownerUserId: quiz.source.ownerUserId }, status: quiz.status }
}

export function answerKey(key: QuizAnswerKey): QuizAnswerKey {
  return {
    quizId: key.quizId, version: key.version,
    answers: key.answers.map(answer => ({
      questionId: answer.questionId, correctAnswers: [...answer.correctAnswers],
      ...(answer.explanation === undefined ? {} : { explanation: answer.explanation }),
    })),
  }
}

export function validateQuizPair(quiz: QuizDefinition, key: QuizAnswerKey): void {
  record(quiz)
  record(key)
  assertQuizId(quiz.id)
  positiveInteger(quiz.version)
  nonemptyString(quiz.name)
  optionalString(quiz.description)
  timestamp(quiz.createdAt)
  if (quiz.publishedAt !== undefined) timestamp(quiz.publishedAt)
  record(quiz.source)
  requireCondition(quiz.source.type === 'admin' || quiz.source.type === 'user', 'Invalid quiz source')
  if (quiz.source.type === 'user') assertUserId(quiz.source.ownerUserId)
  requireCondition(Array.isArray(quiz.questions) && quiz.questions.length > 0, 'Quiz must contain questions')
  const ids = new Set<number>()
  for (const question of quiz.questions) {
    record(question)
    requireCondition(Number.isSafeInteger(question.id) && question.id >= 0 && !ids.has(question.id), 'Invalid or duplicate question ID')
    ids.add(question.id)
    nonemptyString(question.question)
    uniqueStrings(question.options)
    requireCondition(question.options.length >= 2 && question.options.every(option => option.trim().length > 0), 'Invalid question options')
    optionalString(question.category)
    optionalString(question.difficulty)
  }
  requireCondition(key.quizId === quiz.id && key.version === quiz.version, 'Answer key reference mismatch')
  requireCondition(Array.isArray(key.answers) && key.answers.length === ids.size, 'Answer key must cover every question')
  const answered = new Set<number>()
  for (const answer of key.answers) {
    record(answer)
    const question = quiz.questions.find(question => question.id === answer.questionId)
    requireCondition(question && !answered.has(answer.questionId), 'Unknown or duplicate answer-key question')
    answered.add(answer.questionId)
    uniqueStrings(answer.correctAnswers)
    requireCondition(answer.correctAnswers.length > 0 && answer.correctAnswers.every(option => question.options.includes(option)), 'Invalid correct options')
    optionalString(answer.explanation)
  }
}
