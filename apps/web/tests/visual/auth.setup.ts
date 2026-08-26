import { expect, test as setup } from '@playwright/test';

import { SESSIONS } from './helpers';

/**
 * Signs in once per role and saves the sessions the visual projects reuse.
 *
 * Two sessions, not one, because no single role can see both screens: the clerk
 * triages documents and the operator reads the health page. A superuser account
 * that could see everything would photograph screens no real user ever sees, and
 * would hide it if a permission were wrong.
 *
 * Uses the local development sign-in endpoint, which the API refuses unless local
 * accounts are explicitly enabled and which cannot be enabled in production. The
 * accounts come from `apps/api/scripts/seed_dev.py`.
 *
 * Signing in through the API rather than through the form is deliberate: the
 * sign-in screen has its own coverage, and repeating it before every screenshot
 * would make an unrelated form change fail the whole visual suite.
 */

for (const [role, session] of Object.entries(SESSIONS)) {
  setup(`sign in as the ${role}`, async ({ page, request, baseURL }) => {
    const response = await request.post('/api/v1/auth/local/sign-in', {
      data: { email: session.email },
    });

    if (!response.ok()) {
      throw new Error(
        `Could not sign in as ${session.email} (${response.status()}). ` +
          'Run `python scripts/seed_dev.py` in apps/api to create the development accounts.',
      );
    }

    // The cookie is set on the request context; the browser context needs it too,
    // so the saved state covers both API calls and navigation.
    const { cookies } = await request.storageState();
    await page.context().addCookies(cookies);

    await page.goto(`${baseURL ?? ''}/`);
    // Asserted rather than assumed: a saved state that is not actually signed in
    // turns every later screenshot into a picture of the sign-in screen. The
    // timeout is longer than the default because this is the first request to
    // reach a freshly started API, which pays for its connection pool here.
    await expect(page.getByRole('navigation').first()).toBeVisible({
      timeout: 30_000,
    });

    await page.context().storageState({ path: session.storageState });
  });
}
