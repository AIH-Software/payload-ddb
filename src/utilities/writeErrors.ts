import type { PayloadRequest } from 'payload'

import { ValidationError } from 'payload'

import { UniqueViolationError } from './writeItems.js'

/**
 * The error Payload's other adapters raise for a duplicate key: a
 * `ValidationError` naming the field, which core turns into a 400 with a
 * field-level "Value must be unique" message.
 */
export function mustBeUniqueError(
  path: string,
  collection: string,
  req: Partial<PayloadRequest> | undefined,
): ValidationError {
  return new ValidationError(
    {
      collection,
      errors: [
        {
          message: req?.t ? req.t('error:valueMustBeUnique') : 'Value must be unique',
          path,
        },
      ],
      ...(req ? { req } : {}),
    },
    req?.t,
  )
}

/** Re-throw a unique-field violation in Payload's terms; pass anything else through. */
export function rethrowUniqueViolation(
  err: unknown,
  collection: string,
  req: Partial<PayloadRequest> | undefined,
): void {
  if (err instanceof UniqueViolationError) {
    throw mustBeUniqueError(err.path, collection, req)
  }
}
