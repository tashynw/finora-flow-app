/**
 * API client.
 *
 * Errors from the API carry a stable `code` plus human-readable `detail`. The
 * client preserves both, so a caller can branch on the code while the interface
 * shows the message the API wrote. Inventing friendlier text here would hide the
 * reason a financial action was refused.
 */

export const API_PREFIX = '/api/v1';

export interface FieldError {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields: FieldError[];
  readonly correlationId: string | null;

  constructor(
    status: number,
    code: string,
    detail: string,
    fields: FieldError[] = [],
    correlationId: string | null = null,
  ) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
    this.correlationId = correlationId;
  }

  /** True when the record changed underneath the user and a reload is needed. */
  get isStale(): boolean {
    return this.code === 'stale_record';
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }
}

interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Origin prefix. Nest routes sit on `/api/nest`; everything else stays on the Python API. */
  prefix?: string;
  /**
   * Send the session cookie. True everywhere except the supplier's own page.
   *
   * That page is reached by a token in a URL and is meant to work the same for
   * a supplier with no account and for a colleague who happens to be signed in.
   * Withholding the cookie is what makes those two cases identical, so a screen
   * cannot accidentally behave one way in testing and another in a supplier's
   * browser.
   */
  withSession?: boolean;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, headers, withSession = true, prefix = API_PREFIX, ...rest } = options;

  // FormData must be passed through untouched: the browser sets the multipart
  // content type together with the boundary, and setting the header by hand
  // produces a body the server cannot parse.
  const isFormData = body instanceof FormData;

  const response = await fetch(`${prefix}${path}`, {
    ...rest,
    // The session lives in an HttpOnly cookie, so it must be sent explicitly.
    credentials: withSession ? 'same-origin' : 'omit',
    headers: {
      ...(body !== undefined && !isFormData
        ? { 'content-type': 'application/json' }
        : {}),
      ...headers,
    },
    ...(body !== undefined
      ? { body: isFormData ? body : JSON.stringify(body) }
      : {}),
  });

  const correlationId = response.headers.get('x-correlation-id');

  if (response.status === 204) {
    return undefined as T;
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const problem = (payload ?? {}) as {
      code?: string;
      detail?: string;
      message?: string;
      fields?: FieldError[];
    };
    throw new ApiError(
      response.status,
      problem.code ?? 'unknown_error',
      // Python answers with `detail`. Nest answers with `message`. Either sentence
      // is shown unchanged. The fallback is for a response that never reached the
      // application at all, a proxy error page or a dropped connection.
      problem.detail ??
        problem.message ??
        'The request could not be completed. Please try again, and contact support if it keeps happening.',
      problem.fields ?? [],
      correlationId,
    );
  }

  return payload as T;
}

/**
 * The sentence to show for a failed request, or undefined when there was none.
 *
 * Every refusal this API gives carries wording written for the person reading
 * it, and that wording is shown unchanged. A screen that rephrased "this vendor
 * is not on the supplier master" into its own words would eventually rephrase it
 * into something that is no longer true.
 */
export function errorMessage(error: unknown): string | undefined {
  return error instanceof Error ? error.message : undefined;
}

type QueryValue = string | number | boolean | readonly string[] | undefined;

/**
 * Query string from defined values only, so an absent filter is absent.
 *
 * A list is sent as the key repeated once per value, which is what FastAPI reads
 * back into a list parameter. An empty list sends nothing, because a filter on
 * nothing is not a filter.
 */
export function toQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    // Checked by shape rather than with `Array.isArray`, whose signature widens a
    // `readonly string[]` to `any[]` and loses the element type.
    if (typeof value === 'object') {
      for (const item of value) search.append(key, item);
      continue;
    }
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: 'GET' }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body }),
  upload: <T>(path: string, form: FormData) =>
    request<T>(path, { method: 'POST', body: form }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

const NEST_PREFIX = '/api/nest';

/** Nest routes. The session cookie is the same one Better Auth set at sign-in. */
export const nestApi = {
  get: <T>(path: string) => request<T>(path, { method: 'GET', prefix: NEST_PREFIX }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body, prefix: NEST_PREFIX }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body, prefix: NEST_PREFIX }),
};

/**
 * The same client, with the session deliberately left behind.
 *
 * Only the supplier's payment check-in page uses this. Its endpoints authorise
 * nothing — the most either of them does is record what a supplier says about a
 * payment — and they are the only unauthenticated surface in the platform, so
 * they are reached through a named door rather than through `api` with a flag
 * that somebody could set on any other call.
 */
export const publicApi = {
  get: <T>(path: string) => request<T>(path, { method: 'GET', withSession: false }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body, withSession: false }),
};
