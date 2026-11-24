import { api } from './space.js';

export const sampleQuiz = {
  title: 'Derivatives quiz',
  description: 'Warm-up',
  questions: [
    {
      type: 'mcq',
      prompt: 'What is d/dx of x^2?',
      options: ['x', '2x', 'x^2'],
      correctAnswer: '2x',
      explanation: 'Power rule: bring the exponent down.',
    },
    {
      type: 'true_false',
      prompt: 'The derivative of a constant is 0.',
      correctAnswer: true,
      explanation: 'Constants do not change.',
    },
    {
      type: 'short_answer',
      prompt: 'Name the rule used for d/dx (f*g).',
      correctAnswer: ['product rule', 'leibniz rule'],
      explanation: 'It is the product rule.',
      points: 2,
    },
  ],
};

/** Creates a quiz and returns the owner view ({ id, questions: [{ id, ... }], ... }). */
export const createQuiz = async (token, topicId, body = sampleQuiz) => {
  const res = await api('post', `/topics/${topicId}/quizzes`, token, body);
  return res.body.data.quiz;
};

export const submit = (token, quizId, answers, extra = {}) =>
  api('post', `/quizzes/${quizId}/submit`, token, { answers, durationSeconds: 30, ...extra });

/** Builds an answers array from [questionIndex, answer] pairs. */
export const answerSet = (quiz, pairs) =>
  pairs.map(([index, answer]) => ({ questionId: quiz.questions[index].id, answer }));

/** Right answers for sampleQuiz, in question order. */
export const RIGHT = ['2x', true, 'Product Rule'];
/** Wrong answers for sampleQuiz, in question order. */
export const WRONG = ['x', false, 'chain rule'];

/** Answers every question of sampleQuiz; `right[i]` picks the right or wrong answer. */
export const answerAll = (quiz, right) =>
  answerSet(
    quiz,
    quiz.questions.map((_q, i) => [i, right[i] ? RIGHT[i] : WRONG[i]]),
  );

export const createCard = (token, topicId, body = { front: 'Q?', back: 'A.' }) =>
  api('post', `/topics/${topicId}/flashcards`, token, body);
