import { DomainError } from '../domain/errors.js'
import { publicQuiz, validateQuizPair } from '../domain/quizzes.js'
import type { PublicQuizQuestion, QuizAnswer, QuizAnswerKey, QuizDefinition } from '../domain/quizzes.js'
import type { Principal } from '../domain/users.js'
import { onlyKeys } from '../domain/validation.js'
import type { QuizRepository } from '../repositories/QuizRepository.js'
import type { AuthorizationService } from './AuthorizationService.js'

export interface PublishQuizInput {
  id: string
  version: number
  name: string
  description?: string
  questions: PublicQuizQuestion[]
  answers: QuizAnswer[]
}

export class QuizService {
  constructor(
    private readonly quizzes: QuizRepository,
    private readonly authorization: AuthorizationService,
    private readonly now: () => number = Date.now,
  ) {}

  async publishQuiz(principal: Principal, input: PublishQuizInput): Promise<QuizDefinition> {
    await this.authorization.requireAdmin(principal)
    onlyKeys(input, ['id', 'version', 'name', 'description', 'questions', 'answers'])
    const now = this.now()
    const quiz: QuizDefinition = {
      id: input.id, version: input.version, name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      questions: input.questions, source: { type: 'admin' }, createdAt: now, publishedAt: now,
    }
    const key: QuizAnswerKey = { quizId: input.id, version: input.version, answers: input.answers }
    validateQuizPair(quiz, key)
    await this.quizzes.publish(quiz, key)
    return publicQuiz(quiz)
  }

  async listQuizzes(principal: Principal): Promise<QuizDefinition[]> {
    await this.authorization.requireActive(principal)
    return (await this.quizzes.listPublished()).map(publicQuiz)
  }

  async getQuiz(principal: Principal, quizId: string, version: number): Promise<QuizDefinition> {
    await this.authorization.requireActive(principal)
    const quiz = await this.quizzes.getPublished(quizId, version)
    if (!quiz) throw new DomainError('NOT_FOUND', 'Quiz not found')
    return publicQuiz(quiz)
  }
}
