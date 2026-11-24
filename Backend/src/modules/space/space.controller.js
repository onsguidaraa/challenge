import * as spaceService from './space.service.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendSuccess } from '../../utils/response.js';

/* ------------------------------- Subjects ------------------------------ */

export const createSubject = asyncHandler(async (req, res) => {
  const subject = await spaceService.createSubject(req.user._id, req.body);
  sendSuccess(res, { subject }, 'Subject created', 201);
});

export const listSubjects = asyncHandler(async (req, res) => {
  const result = await spaceService.listSubjects(req.user._id, req.query);
  sendSuccess(res, result, 'Subjects');
});

export const getSubject = asyncHandler(async (req, res) => {
  const subject = await spaceService.getSubject(req.user._id, req.params.id);
  sendSuccess(res, { subject }, 'Subject');
});

export const updateSubject = asyncHandler(async (req, res) => {
  const subject = await spaceService.updateSubject(req.user._id, req.params.id, req.body);
  sendSuccess(res, { subject }, 'Subject updated');
});

export const deleteSubject = asyncHandler(async (req, res) => {
  const result = await spaceService.deleteSubject(req.user._id, req.params.id);
  sendSuccess(res, result, 'Subject deleted');
});

/* -------------------------------- Topics ------------------------------- */

export const createTopic = asyncHandler(async (req, res) => {
  const topic = await spaceService.createTopic(req.user._id, req.params.subjectId, req.body);
  sendSuccess(res, { topic }, 'Topic created', 201);
});

export const listTopics = asyncHandler(async (req, res) => {
  const result = await spaceService.listTopics(req.user._id, req.params.subjectId, req.query);
  sendSuccess(res, result, 'Topics');
});

export const reorderTopics = asyncHandler(async (req, res) => {
  const topics = await spaceService.reorderTopics(
    req.user._id,
    req.params.subjectId,
    req.body.topicIds,
  );
  sendSuccess(res, { items: topics }, 'Topics reordered');
});

export const getTopic = asyncHandler(async (req, res) => {
  const topic = await spaceService.getTopic(req.user._id, req.params.id);
  sendSuccess(res, { topic }, 'Topic');
});

export const updateTopic = asyncHandler(async (req, res) => {
  const topic = await spaceService.updateTopic(req.user._id, req.params.id, req.body);
  sendSuccess(res, { topic }, 'Topic updated');
});

export const deleteTopic = asyncHandler(async (req, res) => {
  const result = await spaceService.deleteTopic(req.user._id, req.params.id);
  sendSuccess(res, result, 'Topic deleted');
});

/* ------------------------------- Materials ----------------------------- */

export const createMaterial = asyncHandler(async (req, res) => {
  const material = await spaceService.createMaterial(req.user._id, req.params.topicId, req.body);
  sendSuccess(res, { material }, 'Material created', 201);
});

export const listMaterials = asyncHandler(async (req, res) => {
  const result = await spaceService.listMaterials(req.user._id, req.params.topicId, req.query);
  sendSuccess(res, result, 'Materials');
});

export const getMaterial = asyncHandler(async (req, res) => {
  const material = await spaceService.getMaterial(req.user._id, req.params.id);
  sendSuccess(res, { material }, 'Material');
});

export const updateMaterial = asyncHandler(async (req, res) => {
  const material = await spaceService.updateMaterial(req.user._id, req.params.id, req.body);
  sendSuccess(res, { material }, 'Material updated');
});

export const deleteMaterial = asyncHandler(async (req, res) => {
  const result = await spaceService.deleteMaterial(req.user._id, req.params.id);
  sendSuccess(res, result, 'Material deleted');
});
