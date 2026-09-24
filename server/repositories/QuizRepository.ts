import type { QuizAnswerKey, QuizDefinition } from '../domain/quizzes.js'

export interface QuizRepository {
  publish(quiz: QuizDefinition, key: QuizAnswerKey): Promise<void>
  listPublished(): Promise<QuizDefinition[]>
  getPublished(quizId: string, version: number): Promise<QuizDefinition | undefined>
  /** Backend grading only. Never expose this repository to browser code. */
  getAnswerKey(quizId: string, version: number): Promise<QuizAnswerKey | undefined>
}
