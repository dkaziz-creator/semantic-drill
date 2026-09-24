import type { QuizAnswerKey, UserQuiz } from '../domain/quizzes.js'
import type { Principal } from '../domain/users.js'

export interface UserQuizRepository {
  create(principal: Principal, quiz: UserQuiz, key: QuizAnswerKey): Promise<void>
  list(principal: Principal): Promise<UserQuiz[]>
  get(principal: Principal, quizId: string, version: number): Promise<UserQuiz | undefined>
  /** Internal access, scoped to the authenticated owner just like the content. */
  getAnswerKey(principal: Principal, quizId: string, version: number): Promise<QuizAnswerKey | undefined>
}
