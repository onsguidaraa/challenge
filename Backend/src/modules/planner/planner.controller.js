import * as plannerService from './planner.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

/* --------------------------------- Plans ------------------------------- */

export const createPlan = asyncHandler(async (req, res) => {
  const plan = await plannerService.createPlan(req.user._id, req.body);
  sendSuccess(res, { plan }, 'Study plan created', 201);
});

export const listPlans = asyncHandler(async (req, res) => {
  const result = await plannerService.listPlans(req.user._id, req.query);
  sendSuccess(res, result, 'Study plans');
});

export const getPlan = asyncHandler(async (req, res) => {
  const plan = await plannerService.getPlan(req.user._id, req.params.id);
  sendSuccess(res, { plan }, 'Study plan');
});

export const updatePlan = asyncHandler(async (req, res) => {
  const plan = await plannerService.updatePlan(req.user._id, req.params.id, req.body);
  sendSuccess(res, { plan }, 'Study plan updated');
});

export const deletePlan = asyncHandler(async (req, res) => {
  const result = await plannerService.deletePlan(req.user._id, req.params.id);
  sendSuccess(res, result, 'Study plan deleted');
});

/* --------------------------------- Tasks ------------------------------- */

export const createPlanTask = asyncHandler(async (req, res) => {
  const task = await plannerService.createTask(req.user._id, req.body, req.params.planId);
  sendSuccess(res, { task }, 'Task created', 201);
});

export const listPlanTasks = asyncHandler(async (req, res) => {
  const result = await plannerService.listTasks(req.user._id, req.query, req.params.planId);
  sendSuccess(res, result, 'Tasks');
});

export const createTask = asyncHandler(async (req, res) => {
  const task = await plannerService.createTask(req.user._id, req.body);
  sendSuccess(res, { task }, 'Task created', 201);
});

export const listTasks = asyncHandler(async (req, res) => {
  const result = await plannerService.listTasks(req.user._id, req.query);
  sendSuccess(res, result, 'Tasks');
});

export const getUpcomingTasks = asyncHandler(async (req, res) => {
  const result = await plannerService.getUpcomingTasks(req.user._id, req.query);
  sendSuccess(res, result, 'Upcoming tasks');
});

export const getTask = asyncHandler(async (req, res) => {
  const task = await plannerService.getTask(req.user._id, req.params.id);
  sendSuccess(res, { task }, 'Task');
});

export const updateTask = asyncHandler(async (req, res) => {
  const task = await plannerService.updateTask(req.user._id, req.params.id, req.body);
  sendSuccess(res, { task }, 'Task updated');
});

export const deleteTask = asyncHandler(async (req, res) => {
  const result = await plannerService.deleteTask(req.user._id, req.params.id);
  sendSuccess(res, result, 'Task deleted');
});

export const completeTask = asyncHandler(async (req, res) => {
  const result = await plannerService.completeTask(req.user._id, req.params.id);
  sendSuccess(res, result, 'Task completed');
});

export const reopenTask = asyncHandler(async (req, res) => {
  const result = await plannerService.reopenTask(req.user._id, req.params.id);
  sendSuccess(res, result, 'Task reopened');
});

/* ------------------------------- Sessions ------------------------------ */

export const startSession = asyncHandler(async (req, res) => {
  const result = await plannerService.startSession(req.user._id, req.body);
  sendSuccess(res, result, 'Study session started', 201);
});

export const stopSession = asyncHandler(async (req, res) => {
  const session = await plannerService.stopSession(req.user._id, req.params.id, req.body);
  sendSuccess(res, { session }, 'Study session finished');
});

export const getActiveSession = asyncHandler(async (req, res) => {
  const session = await plannerService.getActiveSession(req.user._id);
  sendSuccess(res, { session }, session ? 'Active study session' : 'No active study session');
});

export const listSessions = asyncHandler(async (req, res) => {
  const result = await plannerService.listSessions(req.user._id, req.query);
  sendSuccess(res, result, 'Study sessions');
});

export const getSessionStats = asyncHandler(async (req, res) => {
  const stats = await plannerService.getSessionStats(req.user._id, req.query);
  sendSuccess(res, stats, 'Study session stats');
});

/* ------------------------------ Suggestions ---------------------------- */

export const getSuggestions = asyncHandler(async (req, res) => {
  const result = await plannerService.getSuggestions(req.user._id, req.query);
  sendSuccess(res, result, 'Study suggestions');
});
