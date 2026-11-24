import { z } from 'zod';
import { LESSON_FORMATS, DIAGRAM_TYPES } from './lessons.model.js';
import { objectId } from '../../utils/objectId.js';

export { topicIdParamSchema } from '../space/space.validation.js';

const requiredText = (max, label) => z.string().trim().min(1, `${label} is required`).max(max);

/**
 * Defense in depth only: SVG is returned verbatim to clients, so obvious script
 * vectors are rejected here. Clients must still sanitize before rendering.
 */
const looksUnsafeSvg = (source) =>
  /<script|<foreignObject|javascript:|\son[a-z]+\s*=/i.test(source);

const diagram = z
  .object({
    type: z.enum(DIAGRAM_TYPES),
    source: requiredText(50000, 'Diagram source'),
  })
  .superRefine((value, ctx) => {
    if (value.type !== 'svg') return;
    if (!/<svg[\s>]/i.test(value.source)) {
      ctx.addIssue({ code: 'custom', path: ['source'], message: 'SVG source must contain <svg>' });
    } else if (looksUnsafeSvg(value.source)) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: 'SVG must not contain scripts, event handlers or foreignObject',
      });
    }
  });

const steps = z
  .array(
    z.object({
      order: z.number().int().min(1).optional(),
      title: requiredText(200, 'Step title'),
      content: requiredText(5000, 'Step content'),
    }),
  )
  .max(50, 'At most 50 steps')
  .transform((items) =>
    items
      .map((step, index) => ({ ...step, order: step.order ?? index + 1 }))
      .sort((a, b) => a.order - b.order),
  );

const examples = z
  .array(
    z.object({
      title: requiredText(200, 'Example title'),
      content: requiredText(5000, 'Example content'),
    }),
  )
  .max(50, 'At most 50 examples');

/** Every key is optional. Empty values ('' / [] / null for diagram) clear a format. */
const formatsInput = z
  .object({
    simplified: z.string().trim().max(20000),
    diagram: diagram.nullable(),
    steps,
    examples,
  })
  .partial();

const title = requiredText(200, 'Title');

/** True if at least one format carries content. */
const hasAnyFormat = (formats = {}) =>
  Boolean(formats.simplified) ||
  Boolean(formats.diagram) ||
  (formats.steps?.length ?? 0) > 0 ||
  (formats.examples?.length ?? 0) > 0;

/** PUT: replaces the whole lesson content. */
export const putLessonSchema = z.object({
  title,
  formats: formatsInput.refine(hasAnyFormat, 'Provide content for at least one format'),
});

/** Quiz ids. Ownership is checked in the service; an empty list unlinks all exercises. */
const exercises = z
  .array(objectId)
  .max(50, 'At most 50 exercises')
  .refine((ids) => new Set(ids.map((id) => id.toLowerCase())).size === ids.length, {
    message: 'Exercise ids must be unique',
  });

/** PATCH: only the supplied title / format keys / exercises change. */
export const patchLessonSchema = z
  .object({
    title,
    formats: formatsInput.refine((f) => Object.keys(f).length > 0, 'Provide at least one format'),
    exercises,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, 'Provide at least one field to update');

export const getLessonQuerySchema = z.object({
  format: z.enum([...LESSON_FORMATS, 'all']).default('all'),
});
