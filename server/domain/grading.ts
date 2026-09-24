import type { AttemptSettings, Grade } from './attempts.js'
import { parseSettings, selectedQuestions } from './attempts.js'
import type { QuizAnswerKey, QuizDefinition } from './quizzes.js'
import { validateQuizPair } from './quizzes.js'

/** Pure backend grading. Missing selections are unanswered; submitted [] is incorrect, as in v1. */
export function gradeAttempt(
  quiz: QuizDefinition,
  key: QuizAnswerKey,
  answers: Record<number, string[]>,
  settings: Pick<AttemptSettings, 'categories' | 'passPercentage'>,
): Grade {
  validateQuizPair(quiz, key)
  const questions = selectedQuestions(quiz, parseSettings(settings))
  const byId = new Map(key.answers.map(answer => [answer.questionId, answer.correctAnswers]))
  let correct = 0
  let unanswered = 0
  for (const question of questions) {
    const selected = answers[question.id]
    const expected = byId.get(question.id)!
    if (selected === undefined) unanswered++
    else if (selected.length === expected.length && new Set(selected).size === selected.length
      && selected.every(option => expected.includes(option))) correct++
  }
  const total = questions.length
  const percentage = total === 0 ? 0 : Math.round(correct / total * 100)
  return { correct, incorrect: total - correct - unanswered, unanswered, total, percentage, passed: percentage >= settings.passPercentage }
}
