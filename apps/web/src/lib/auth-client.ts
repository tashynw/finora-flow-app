import { createAuthClient } from 'better-auth/react';
import { inferAdditionalFields } from 'better-auth/client/plugins';

/**
 * Better Auth client for the Nest server.
 *
 * Requests stay on this origin (`/api/auth`). Vite forwards that prefix to the
 * Nest process, so the session cookie is set for the page the user is on.
 */
export const authClient = createAuthClient({
  plugins: [
    inferAdditionalFields({
      user: {
        role: {
          type: 'string',
        },
        departmentId: {
          type: 'string',
          required: false,
        },
        jobTitle: {
          type: 'string',
          required: false,
        },
      },
    }),
  ],
});
