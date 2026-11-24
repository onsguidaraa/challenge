/**
 * Validates req.body / req.params / req.query against Zod schemas.
 * Parsed (coerced, trimmed, stripped) values replace the originals.
 * ZodErrors are forwarded to the error handler.
 *
 * Usage: validate({ body: schema, params: schema, query: schema })
 */
export const validate =
  (schemas = {}) =>
  (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // req.query is a getter in Express 5, so it has to be redefined.
        Object.defineProperty(req, 'query', {
          value: schemas.query.parse(req.query),
          writable: true,
          configurable: true,
          enumerable: true,
        });
      }
      if (schemas.body) req.body = schemas.body.parse(req.body);
      next();
    } catch (err) {
      next(err);
    }
  };
