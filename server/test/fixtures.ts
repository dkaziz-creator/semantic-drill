import type { Principal, UserRecord } from '../domain/users.js'
import type { QuizAnswerKey, QuizDefinition } from '../domain/quizzes.js'
import type { PublishQuizInput } from '../services/QuizService.js'

export const admin: Principal = { userId: '00000000-0000-4000-8000-000000000001', role: 'admin' }
export const alice: Principal = { userId: '00000000-0000-4000-8000-000000000002', role: 'student' }
export const bob: Principal = { userId: '00000000-0000-4000-8000-000000000003', role: 'student' }

export function user(principal: Principal, login: string): UserRecord {
  return {
    id: principal.userId, login, displayName: login, role: principal.role, status: 'active',
    auth: { type: 'unconfigured' }, leaderboard: { optIn: false }, createdAt: 1_000, updatedAt: 1_000,
  }
}

export const quiz: QuizDefinition = {
  id: 'neuro', version: 1, name: 'Neuro', source: { type: 'admin' }, createdAt: 1_000, publishedAt: 1_000,
  questions: [
    { id: 1, question: 'Single?', options: ['A', 'B', 'C'], category: 'single' },
    { id: 2, question: 'Multiple?', options: ['A', 'B', 'C'], category: 'multi' },
    { id: 3, question: 'Third?', options: ['Yes', 'No'], category: 'single' },
  ],
}
export const key: QuizAnswerKey = {
  quizId: quiz.id, version: 1,
  answers: [
    { questionId: 1, correctAnswers: ['A'], explanation: 'Secret explanation' },
    { questionId: 2, correctAnswers: ['A', 'C'] },
    { questionId: 3, correctAnswers: ['Yes'] },
  ],
}
export function publishInput(): PublishQuizInput {
  return structuredClone({ id: quiz.id, version: quiz.version, name: quiz.name, questions: quiz.questions, answers: key.answers })
}
export const quizRef = { scope: 'catalog', quizId: quiz.id, version: 1 } as const
