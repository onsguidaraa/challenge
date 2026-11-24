import { z } from 'zod';
import { objectId, idParam } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';
import { TOPIC_STATUSES, TOPIC_DIFFICULTIES, MATERIAL_TYPES } from './space.model.js';

const requiredText = (max, label) => z.string().trim().min(1, `${label} is required`).max(max);

const atLeastOneField = [
  (body) => Object.keys(body).length > 0,
  'Provide at least one field to update',
];

/* ------------------------------- Params -------------------------------- */

export const idParamSchema = idParam('id');
export const subjectIdParamSchema = idParam('subjectId');
export const topicIdParamSchema = idParam('topicId');

/* ------------------------------- Subject ------------------------------- */

const subjectFields = {
  name: requiredText(100, 'Name'),
  description: z.string().trim().max(1000),
  color: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #4f46e5')
    .nullable(),
  icon: z.string().trim().min(1).max(50).nullable(),
  archived: z.boolean(),
};

export const createSubjectSchema = z.object({
  ...subjectFields,
  description: subjectFields.description.optional(),
  color: subjectFields.color.optional(),
  icon: subjectFields.icon.optional(),
  archived: subjectFields.archived.optional(),
});

export const updateSubjectSchema = z
  .object(subjectFields)
  .partial()
  .refine(...atLeastOneField);

export const listSubjectsQuerySchema = z.object({
  ...paginationQuery,
  archived: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  search: z.string().trim().max(100).optional(),
});

/* -------------------------------- Topic -------------------------------- */

const topicFields = {
  title: requiredText(200, 'Title'),
  description: z.string().trim().max(2000),
  status: z.enum(TOPIC_STATUSES),
  difficulty: z.enum(TOPIC_DIFFICULTIES),
};

export const createTopicSchema = z.object({
  title: topicFields.title,
  description: topicFields.description.optional(),
  status: topicFields.status.optional(),
  difficulty: topicFields.difficulty.optional(),
});

export const updateTopicSchema = z
  .object(topicFields)
  .partial()
  .refine(...atLeastOneField);

export const listTopicsQuerySchema = z.object({
  ...paginationQuery,
  status: topicFields.status.optional(),
  difficulty: topicFields.difficulty.optional(),
});

export const reorderTopicsSchema = z.object({
  topicIds: z
    .array(objectId)
    .min(1, 'Provide at least one topic id')
    .max(500)
    .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
      message: 'Topic ids must be unique',
    }),
});

/* ------------------------------- Material ------------------------------ */

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .pipe(z.url({ protocol: /^https?$/, error: 'Must be a valid http(s) URL' }));

const mimeType = z
  .string()
  .trim()
  .toLowerCase()
  .max(127)
  .regex(
    /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/,
    'Must be a valid MIME type like application/pdf',
  );

const tags = z
  .array(z.string().trim().min(1, 'Tags must not be empty').max(50))
  .max(20, 'At most 20 tags')
  .transform((items) => [...new Set(items)]);

const materialFields = {
  title: requiredText(200, 'Title'),
  content: requiredText(50000, 'Content'),
  url: httpUrl,
  fileUrl: httpUrl,
  mimeType,
  tags,
};

const common = { title: materialFields.title, tags: materialFields.tags.default([]) };

/** Each type requires its own fields; fields of other types are stripped. */
export const materialSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('note'), content: materialFields.content }),
  z.object({ ...common, type: z.literal('link'), url: materialFields.url }),
  z.object({
    ...common,
    type: z.literal('file'),
    fileUrl: materialFields.fileUrl,
    mimeType: materialFields.mimeType,
  }),
]);

export const createMaterialSchema = materialSchema;

/**
 * PATCH body. Which fields are valid depends on the stored type, so the final
 * per-type check is done in the service by re-validating the merged document
 * against `materialSchema`. `type` may be sent but must match the stored one.
 */
export const updateMaterialSchema = z
  .object({ ...materialFields, type: z.enum(MATERIAL_TYPES) })
  .partial()
  .refine(...atLeastOneField);

export const listMaterialsQuerySchema = z.object({
  ...paginationQuery,
  type: z.enum(MATERIAL_TYPES).optional(),
});
