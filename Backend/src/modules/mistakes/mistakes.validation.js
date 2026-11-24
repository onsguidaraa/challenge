import { z } from 'zod';
import { objectId } from '../../utils/objectId.js';
import { paginationQuery } from '../../utils/pagination.js';

export { idParamSchema } from '../space/space.validation.js';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listMistakesQuerySchema = z.object({
  ...paginationQuery,
  topic: objectId.optional(),
  subject: objectId.optional(),
  resolved: booleanString.optional(),
});

export const weakTopicsQuerySchema = z.object({ ...paginationQuery });

// The body is optional: a bare POST means "any topic, default size".
export const practiceMistakesSchema = z.preprocess(
  (body) => body ?? {},
  z.object({
    topic: objectId.optional(),
    subject: objectId.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }),
);
