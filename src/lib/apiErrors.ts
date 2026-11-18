/**
 * Shared API error helpers.
 *
 * Route handlers must not turn a failed authoritative database query or
 * upstream fetch into a successful-looking empty payload. These helpers
 * produce one consistent JSON shape (`error` plus the original `details`)
 * and set `no-store` so a transient 5xx is never cached by a browser or CDN.
 */

/** Convert any thrown value into a useful, non-throwing detail string. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/**
 * Build a descriptive JSON error response. `cause` is optional for validation
 * and configuration failures; passing it includes `details` for DB/upstream
 * failures and logs the original error server-side.
 */
export function apiError(
  error: string,
  cause?: unknown,
  status = 500,
  extra?: Record<string, unknown>,
): Response {
  const details = cause === undefined ? undefined : errorMessage(cause);
  if (cause !== undefined) {
    console.error(`[API] ${error}: ${details}`);
  }

  return Response.json(
    {
      error,
      ...(details !== undefined ? { details } : {}),
      ...(extra ?? {}),
    },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    },
  );
}

/** Wrap a route handler so unhandled failures become descriptive 500 JSON. */
export function withRouteErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response> | Response,
  label: string,
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (cause) {
      return apiError(`${label} failed`, cause);
    }
  };
}
