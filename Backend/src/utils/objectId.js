import { z } from 'zod';

/** A 24-char hex string. Stricter than mongoose.isValidObjectId (which accepts any 12-char string). */
export const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');

/** Params schema for a single ObjectId route param, e.g. idParam('topicId'). */
export const idParam = (name = 'id') => z.object({ [name]: objectId });
