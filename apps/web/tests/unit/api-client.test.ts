import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, ApiError, API_PREFIX, publicApi, toQuery } from '@/lib/api-client';

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The URL and init passed to `fetch` on a given call. */
function callArgs(index: number): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[index] as [string, RequestInit] | undefined;
  if (!call) {
    throw new Error(`fetch was not called ${index + 1} time(s)`);
  }
  return { url: call[0], init: call[1] };
}

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request wiring', () => {
  it('prefixes the versioned API path', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    await api.get('/health');
    expect(callArgs(0).url).toBe(`${API_PREFIX}/health`);
  });

  it('sends the session cookie, which lives in an HttpOnly cookie', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await api.get('/auth/me');
    expect(callArgs(0).init).toMatchObject({ credentials: 'same-origin' });
  });

  it('withholds the session on the supplier’s own endpoints', async () => {
    // The supplier's page must behave identically for a supplier with no
    // account and for a colleague who happens to be signed in. Omitting the
    // cookie is what makes those two cases the same request, so a screen cannot
    // work in testing and fail in a supplier's browser.
    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await publicApi.get('/payment-check-in/token-123');
    expect(callArgs(0).init).toMatchObject({ credentials: 'omit' });

    fetchMock.mockResolvedValue(jsonResponse(200, {}));
    await publicApi.post('/payment-check-in/token-123', { claim: 'received' });
    expect(callArgs(1).init).toMatchObject({ credentials: 'omit', method: 'POST' });
  });

  it('sets a JSON content type only when there is a body', async () => {
    // A Response body can only be read once, so each call needs a fresh one.
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, {})));

    await api.post('/estimates', { reference: 'EST-1' });
    expect(callArgs(0).init).toMatchObject({
      body: '{"reference":"EST-1"}',
      headers: { 'content-type': 'application/json' },
    });

    await api.get('/estimates');
    expect(callArgs(1).init.headers).toEqual({});
  });

  it('returns undefined for a 204 without trying to parse a body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(api.delete('/sessions/current')).resolves.toBeUndefined();
  });
});

describe('error handling', () => {
  it('preserves the API code and message rather than inventing friendlier text', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        409,
        {
          code: 'stale_record',
          detail: 'This invoice changed while you were reviewing it.',
        },
        { 'x-correlation-id': 'corr-123' },
      ),
    );

    const error = await api.post('/invoices/1/approve').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe('stale_record');
    expect(apiError.message).toBe(
      'This invoice changed while you were reviewing it.',
    );
    expect(apiError.isStale).toBe(true);
    expect(apiError.correlationId).toBe('corr-123');
  });

  it('surfaces field errors so a form can point at the offending input', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(422, {
        code: 'validation_error',
        detail: 'Check the highlighted fields.',
        fields: [{ field: 'amount', message: 'Amount must be greater than zero.' }],
      }),
    );

    const error = (await api
      .post('/invoices', {})
      .catch((e: unknown) => e)) as ApiError;

    expect(error.fields).toEqual([
      { field: 'amount', message: 'Amount must be greater than zero.' },
    ]);
  });

  it('classifies authentication and authorization failures distinctly', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { code: 'unauthenticated' }));
    const unauth = (await api.get('/auth/me').catch((e: unknown) => e)) as ApiError;
    expect(unauth.isUnauthenticated).toBe(true);
    expect(unauth.isForbidden).toBe(false);

    fetchMock.mockResolvedValue(jsonResponse(403, { code: 'forbidden' }));
    const forbidden = (await api
      .get('/audit')
      .catch((e: unknown) => e)) as ApiError;
    expect(forbidden.isForbidden).toBe(true);
    expect(forbidden.isUnauthenticated).toBe(false);
  });

  it('still fails clearly when the error body is not JSON', async () => {
    fetchMock.mockResolvedValue(
      new Response('<html>502 Bad Gateway</html>', { status: 502 }),
    );

    const error = (await api.get('/health').catch((e: unknown) => e)) as ApiError;
    expect(error.code).toBe('unknown_error');
    expect(error.message).toContain('could not be completed');
    expect(error.fields).toEqual([]);
  });
});

describe('toQuery', () => {
  it('leaves out a filter nobody set', () => {
    // An absent filter has to be absent from the URL, not sent as an empty value
    // the API would then have to interpret.
    expect(toQuery({ state: undefined, search: '', limit: 25 })).toBe('?limit=25');
  });

  it('returns nothing at all when every value is absent', () => {
    expect(toQuery({ state: undefined, search: '' })).toBe('');
  });

  it('repeats the key for a list, which is what FastAPI reads back as one', () => {
    expect(toQuery({ state: ['draft', 'approved'] })).toBe('?state=draft&state=approved');
  });

  it('treats an empty list as no filter', () => {
    expect(toQuery({ state: [] })).toBe('');
  });

  it('sends a boolean flag as a word the API parses', () => {
    expect(toQuery({ mine: true })).toBe('?mine=true');
  });

  it('escapes what a person typed', () => {
    expect(toQuery({ search: 'Kingston & Sons' })).toBe('?search=Kingston+%26+Sons');
  });
});
