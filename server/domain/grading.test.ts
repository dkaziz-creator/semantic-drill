import { describe, expect, it } from 'vitest'
import { gradeAttempt } from './grading.js'
import { key, quiz } from '../test/fixtures.js'

const settings = { categories: [], passPercentage: 70 }

describe('server grading', () => {
  it.each([
    { selected: ['A', 'C'], correct: 1 },
    { selected: ['C', 'A'], correct: 1 },
    { selected: ['A'], correct: 0 },
    { selected: ['C'], correct: 0 },
    { selected: ['A', 'B', 'C'], correct: 0 },
    { selected: ['A', 'B'], correct: 0 },
    { selected: ['A', 'A'], correct: 0 },
    { selected: [], correct: 0 },
  ])('requires exactly the correct set: $selected', ({ selected, correct }) => {
    expect(gradeAttempt(quiz, key, { 2: selected }, settings)).toMatchObject({ correct, incorrect: 1 - correct, unanswered: 2, total: 3 })
  })

  it('grades single answers and rounds percentages like v1', () => {
    expect(gradeAttempt(quiz, key, { 1: ['A'], 2: ['C', 'A'] }, { ...settings, passPercentage: 67 })).toEqual({
      correct: 2, incorrect: 0, unanswered: 1, total: 3, percentage: 67, passed: true,
    })
    expect(gradeAttempt(quiz, key, { 1: ['B'] }, settings)).toMatchObject({ correct: 0, incorrect: 1, unanswered: 2, passed: false })
  })

  it('only grades categories selected at the start', () => {
    expect(gradeAttempt(quiz, key, { 1: ['B'], 2: ['A', 'C'] }, { categories: ['multi'], passPercentage: 100 })).toEqual({
      correct: 1, incorrect: 0, unanswered: 0, total: 1, percentage: 100, passed: true,
    })
  })

  it('rejects missing, duplicate, unknown or mismatched answer keys', () => {
    for (const invalid of [
      { ...key, version: 2 }, { ...key, answers: key.answers.slice(1) },
      { ...key, answers: [key.answers[0], key.answers[0], key.answers[2]] },
      { ...key, answers: [{ questionId: 1, correctAnswers: ['unknown'] }, ...key.answers.slice(1)] },
    ]) expect(() => gradeAttempt(quiz, invalid, {}, settings)).toThrow()
  })
})
