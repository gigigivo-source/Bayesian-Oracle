// ĞIGI GIVØ — Shared authorization for cron / maintenance endpoints.
//
// These routes mutate the database and burn upstream provider quota, so the
// policy is deliberately narrow and identical everywhere:
//
//   · CRON_SECRET set      → the request must present it as a bearer token
//                            (`Authorization: Bearer <secret>`). Mismatch = 401.
//   · CRON_SECRET unset    → the request is authorized ONLY outside production.
//                            A production deploy that forgot the variable fails
//                            CLOSED instead of silently exposing every write
//                            endpoint (this used to be `if (!secret) return true`).
//
// Secrets are NEVER accepted from the query string: `?key=` / `?secret=` end up
// in access logs, proxy logs, browser history and Referer headers. Header only.
//
// Comparison uses `crypto.timingSafeEqual` over equal-length buffers so the
// endpoint does not leak the secret's length/prefix through response timing.

import { timingSafeEqual } from "node:crypto";

/** The configured cron secret, trimmed; empty string when unset. */
export function cronSecret(): string {
  return (process.env.CRON_SECRET ?? "").trim();
}

/** The configured backfill secret, trimmed; empty string when unset. */
export function backfillSecret(): string {
  return (process.env.BACKFILL_SECRET ?? "").trim();
}

/**
 * True when a production deploy has no BACKFILL_SECRET configured. The backfill
 * falls back to CRON_SECRET, so it is only "missing" when both are unset.
 */
export function backfillSecretMissingInProduction(): boolean {
  return (
    process.env.NODE_ENV === "production" &&
    backfillSecret().length === 0 &&
    cronSecret().length === 0
  );
}

function safeEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length mismatch — compare a fixed-size digest
  // instead so the early return never reveals the expected length.
  if (a.length !== b.length) {
    // Still do a constant-time comparison of equal-length buffers so the
    // failure path costs the same as a wrong-value comparison.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Extract the presented secret from the Authorization header (bearer only). */
function presentedSecret(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * Whether this request may run a protected maintenance route.
 *
 * `secret` is the value the route requires; `fallback` is accepted as an
 * alternative (the backfill accepts either BACKFILL_SECRET or CRON_SECRET).
 *
 * `allowUnauthenticatedInDev` (default true) preserves the old open behaviour
 * for local development and tests, where no secret is configured.
 */
export function isAuthorized(
  req: Request,
  secrets: string[],
  opts: { allowUnauthenticatedInDev?: boolean } = {},
): boolean {
  const expected = secrets.map((v) => v.trim()).filter((v) => v.length > 0);
  if (expected.length === 0) {
    if (process.env.NODE_ENV === "production") return false;
    return opts.allowUnauthenticatedInDev ?? true;
  }
  const provided = presentedSecret(req);
  // Evaluate every candidate so the cost does not depend on which one matches.
  return expected.reduce<boolean>(
    (ok, candidate) => safeEqual(provided, candidate) || ok,
    false,
  );
}

/** Whether this request may run a CRON_SECRET-protected route. */
export function isAuthorizedCron(
  req: Request,
  opts: { allowUnauthenticatedInDev?: boolean } = {},
): boolean {
  return isAuthorized(req, [cronSecret()], opts);
}

/** Whether this request may run a BACKFILL_SECRET-protected route. */
export function isAuthorizedBackfill(req: Request): boolean {
  return isAuthorized(req, [backfillSecret(), cronSecret()]);
}

/** 401 payload shared by every protected route. */
export function unauthorizedResponse(
  body: Record<string, unknown> = { error: "Unauthorized" },
): Response {
  return Response.json(body, { status: 401 });
}

/**
 * One-line guard for route handlers:
 *
 *   const denied = requireCronAuth(req);
 *   if (denied) return denied;
 */
export function requireCronAuth(req: Request): Response | null {
  if (isAuthorizedCron(req)) return null;
  // A missing secret in production is a configuration error, not a bad guess —
  // say so in the body so operators can tell the two apart in logs.
  if (process.env.NODE_ENV === "production" && cronSecret().length === 0) {
    return Response.json(
      { error: "Unauthorized", reason: "CRON_SECRET is not configured" },
      { status: 401 },
    );
  }
  return unauthorizedResponse();
}

/**
 * One-line guard for the backfill route (accepts BACKFILL_SECRET or
 * CRON_SECRET, header only, fail closed in production).
 */
export function requireBackfillAuth(req: Request): Response | null {
  if (isAuthorizedBackfill(req)) return null;
  if (backfillSecretMissingInProduction()) {
    return Response.json(
      { error: "Unauthorized", reason: "BACKFILL_SECRET is not configured" },
      { status: 401 },
    );
  }
  return unauthorizedResponse();
}
