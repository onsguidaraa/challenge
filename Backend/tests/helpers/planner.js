import { api } from './space.js';

export const DAY = 24 * 60 * 60 * 1000;
export const HOUR = 60 * 60 * 1000;
export const fakeId = '64b000000000000000000001';

export const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

export const createPlan = async (token, body = {}) => {
  const res = await api('post', '/plans', token, { title: 'Exam prep', ...body });
  return res.body.data.plan;
};

export const createPlanTask = async (token, planId, body = {}) => {
  const res = await api('post', `/plans/${planId}/tasks`, token, {
    title: 'Read chapter',
    ...body,
  });
  return res.body.data.task;
};

export const createTask = async (token, body = {}) => {
  const res = await api('post', '/tasks', token, { title: 'Standalone', ...body });
  return res.body.data.task;
};

export const complete = (token, taskId) => api('patch', `/tasks/${taskId}/complete`, token);
export const startSession = (token, body = {}) => api('post', '/sessions/start', token, body);
export const stopSession = (token, id, body = {}) =>
  api('post', `/sessions/${id}/stop`, token, body);
