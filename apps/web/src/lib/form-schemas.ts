import { z } from 'zod';

/** A non-blank string. Whitespace alone does not count. */
export function requiredText(message: string) {
  return z.string().trim().min(1, message);
}

/** The written reason recorded against an audited change. */
export const auditReason = z
  .string()
  .trim()
  .min(3, 'A reason of at least 3 characters is required.');

/** Blank is allowed. A value that is present must be an email address. */
export const optionalEmail = z
  .string()
  .trim()
  .refine(
    (value) => value.length === 0 || z.email().safeParse(value).success,
    'Enter a valid email address.',
  );
