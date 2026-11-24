import request from 'supertest';
import app from '../../src/app.js';
import { API, bearer } from './auth.js';

export const api = (method, path, token, body) => {
  const req = request(app)[method](`${API}${path}`).set(bearer(token));
  return body === undefined ? req : req.send(body);
};

export const createSubject = async (token, name = 'Mathematics', extra = {}) => {
  const res = await api('post', '/subjects', token, { name, ...extra });
  return res.body.data.subject;
};

export const createTopic = async (token, subjectId, title = 'Derivatives', extra = {}) => {
  const res = await api('post', `/subjects/${subjectId}/topics`, token, { title, ...extra });
  return res.body.data.topic;
};

export const createNote = async (token, topicId, title = 'My note') => {
  const res = await api('post', `/topics/${topicId}/materials`, token, {
    type: 'note',
    title,
    content: 'Some content',
  });
  return res.body.data.material;
};

export const fullLesson = {
  title: 'Intro to derivatives',
  formats: {
    simplified: 'A derivative is how fast something changes.',
    diagram: { type: 'mermaid', source: 'graph TD; A-->B' },
    steps: [
      { order: 2, title: 'Apply the rule', content: 'Multiply by the exponent.' },
      { order: 1, title: 'Identify the power', content: 'Look at x^n.' },
    ],
    examples: [{ title: 'x^2', content: 'd/dx x^2 = 2x' }],
  },
};

export const createLesson = (token, topicId, body = fullLesson) =>
  api('put', `/topics/${topicId}/lesson`, token, body);
