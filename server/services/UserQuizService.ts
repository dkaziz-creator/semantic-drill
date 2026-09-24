import type { ServerFeatures } from '../config/features.js'
import { DomainError } from '../domain/errors.js'
import { privateQuiz } from '../domain/quizzes.js'
import type { UserQuiz, UserQuizStatus } from '../domain/quizzes.js'
import type { Principal } from '../domain/users.js'
import { onlyKeys } from '../domain/validation.js'
import type { UserQuizRepository } from '../repositories/UserQuizRepository.js'
import type { AuthorizationService } from './AuthorizationService.js'
import type { PublishQuizInput } from './QuizService.js'

export type CreateUserQuizInput = PublishQuizInput & { status?: UserQuizStatus }

export class UserQuizService {
  constructor(
    private readonly quizzes: UserQuizRepository,
    private readonly authorization: AuthorizationService,
    private readonly features: ServerFeatures,
    private readonly now: () => number = Date.now,
  ) {}

  private async authorize(principal: Principal): Promise<void> {
    if (!this.features.userQuizzesEnabled) throw new DomainError('FEATURE_DISABLED', 'User quizzes are disabled')
    await this.authorization.requireActive(principal)
  }

  async createQuiz(principal: Principal, input: CreateUserQuizInput): Promise<UserQuiz> {
    await this.authorize(principal)
    onlyKeys(input, ['id', 'version', 'name', 'description', 'questions', 'answers', 'status'])
    const quiz: UserQuiz = {
      id: input.id, version: input.version, name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      questions: input.questions, source: { type: 'user', ownerUserId: principal.userId },
      createdAt: this.now(), status: input.status ?? 'draft',
    }
    await this.quizzes.create(principal, quiz, { quizId: input.id, version: input.version, answers: input.answers })
    return privateQuiz(quiz)
  }

  async listQuizzes(principal: Principal): Promise<UserQuiz[]> {
    await this.authorize(principal)
    return (await this.quizzes.list(principal)).map(privateQuiz)
  }

  async getQuiz(principal: Principal, quizId: string, version: number): Promise<UserQuiz> {
    await this.authorize(principal)
    const quiz = await this.quizzes.get(principal, quizId, version)
    if (!quiz) throw new DomainError('NOT_FOUND', 'Quiz not found')
    return privateQuiz(quiz)
  }

  async publishQuiz(principal: Principal): Promise<never> {
    await this.authorize(principal)
    // A future feature flag must not accidentally turn on unreviewed catalog publication.
    throw new DomainError('NOT_IMPLEMENTED', 'User quiz publication is not implemented')
  }
}
