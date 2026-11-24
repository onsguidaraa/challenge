import * as lessonsService from './lessons.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

export const putLesson = asyncHandler(async (req, res) => {
  const { lesson, created } = await lessonsService.putLesson(
    req.user._id,
    req.params.topicId,
    req.body,
  );
  sendSuccess(res, { lesson }, created ? 'Lesson created' : 'Lesson replaced', created ? 201 : 200);
});

export const patchLesson = asyncHandler(async (req, res) => {
  const lesson = await lessonsService.patchLesson(req.user._id, req.params.topicId, req.body);
  sendSuccess(res, { lesson }, 'Lesson updated');
});

export const deleteLesson = asyncHandler(async (req, res) => {
  const result = await lessonsService.deleteLesson(req.user._id, req.params.topicId);
  sendSuccess(res, result, 'Lesson deleted');
});

export const getLesson = asyncHandler(async (req, res) => {
  const result = await lessonsService.openLesson(
    req.user._id,
    req.params.topicId,
    req.query.format,
  );
  sendSuccess(res, result, 'Lesson');
});

export const getFormats = asyncHandler(async (req, res) => {
  const result = await lessonsService.getFormats(req.user._id, req.params.topicId);
  sendSuccess(res, result, 'Lesson formats');
});

export const completeLesson = asyncHandler(async (req, res) => {
  const result = await lessonsService.completeLesson(req.user._id, req.params.topicId);
  sendSuccess(res, result, 'Lesson completed');
});
