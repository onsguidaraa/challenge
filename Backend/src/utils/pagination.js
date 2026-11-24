import { z } from 'zod';

/** Spread into a Zod query schema: z.object({ ...paginationQuery, status: ... }). */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const paginate = ({ page, limit }) => ({ skip: (page - 1) * limit, limit });

/** Standard list payload: { items, page, limit, total }. */
export const pageResult = (items, { page, limit }, total) => ({ items, page, limit, total });
