import * as mistakesService from './mistakes.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

export const listMistakes = asyncHandler(async (req, res) => {
  const result = await mistakesService.listMistakes(req.user._id, req.query);
  sendSuccess(res, result, 'Mistakes');
});

export const getWeakTopics = asyncHandler(async (req, res) => {
  const result = await mistakesService.getWeakTopics(req.user._id, req.query);
  sendSuccess(res, result, 'Weak topics');
});

export const getMistake = asyncHandler(async (req, res) => {
  const mistake = await mistakesService.getMistake(req.user._id, req.params.id);
  sendSuccess(res, { mistake }, 'Mistake');
});

export const resolveMistake = asyncHandler(async (req, res) => {
  const mistake = await mistakesService.resolveMistake(req.user._id, req.params.id);
  sendSuccess(res, { mistake }, 'Mistake resolved');
});

export const unresolveMistake = asyncHandler(async (req, res) => {
  const mistake = await mistakesService.unresolveMistake(req.user._id, req.params.id);
  sendSuccess(res, { mistake }, 'Mistake reopened');
});

export const practiceMistakes = asyncHandler(async (req, res) => {
  const practice = await mistakesService.buildPracticeSet(req.user._id, req.body);
  sendSuccess(res, { practice }, 'Mistake practice');
});
