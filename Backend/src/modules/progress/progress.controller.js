import * as progressService from './progress.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

export const getSummary = asyncHandler(async (req, res) => {
  const summary = await progressService.getSummary(req.user._id);
  sendSuccess(res, summary, 'Progress summary');
});

export const getSubjects = asyncHandler(async (req, res) => {
  const result = await progressService.getSubjectsProgress(req.user._id, req.query);
  sendSuccess(res, result, 'Progress per subject');
});

export const getSubject = asyncHandler(async (req, res) => {
  const result = await progressService.getSubjectProgress(req.user._id, req.params.id);
  sendSuccess(res, result, 'Subject progress');
});

export const getQuizzes = asyncHandler(async (req, res) => {
  const result = await progressService.getQuizHistory(req.user._id, req.query);
  sendSuccess(res, result, 'Quiz score history');
});

export const getActivity = asyncHandler(async (req, res) => {
  const result = await progressService.getActivityTimeline(req.user._id, req.query);
  sendSuccess(res, result, 'Activity timeline');
});

export const getHeatmap = asyncHandler(async (req, res) => {
  const result = await progressService.getHeatmap(req.user._id, req.query);
  sendSuccess(res, result, 'Activity heatmap');
});

export const getWeeklyReport = asyncHandler(async (req, res) => {
  const result = await progressService.getWeeklyReport(req.user._id);
  sendSuccess(res, result, 'Weekly report');
});
