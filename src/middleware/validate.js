'use strict';

const { badRequest } = require('./errorHandler');

/**
 * Validation wrapper around a zod schema.
 * Validates the chosen request part ('body' | 'query' | 'params'), replaces it
 * with the parsed/coerced value, and returns a 400 with field details on failure.
 *
 * Usage: router.post('/', validate(schema), controller)
 *        router.get('/', validate(schema, 'query'), controller)
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const details = result.error.issues
        .map((i) => `${i.path.join('.') || source}: ${i.message}`)
        .join('; ');
      return next(badRequest(details, 'VALIDATION_ERROR'));
    }
    // Assign parsed values back (coercion, defaults applied). req.query is a
    // getter-only in some setups, so guard the assignment.
    try {
      req[source] = result.data;
    } catch {
      req.validated = req.validated || {};
      req.validated[source] = result.data;
    }
    return next();
  };
}

module.exports = { validate };
