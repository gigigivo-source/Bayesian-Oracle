// Guards the auth policy for every cron / maintenance endpoint.
//
// The bug this replaces: each route had its own `if (!secret) return true`,
// so a production deploy that forgot CRON_SECRET left /api/cron,
// /api/cron/settle, /api/cron/daily-picks, /api/va/scan (and the backfill)
// open to the public internet. These tests pin the contract:
//
//   · production + no secret      → DENY
//   · production + wrong secret   → DENY
//   · production + right secret   → ALLOW
//   · dev/test + no secret        → ALLOW (local convenience, unchanged)
//   · query strings never work    → query secrets are ignored

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAuthorizedCron,
  isAuthorizedBackfill,
  requireCronAuth,
  requireBackfillAuth,
  cronSecret,
} from "./apiAuth";

function req(url = "https://app.test/api/cron", headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.BACKFILL_SECRET;
  vi.unstubAllEnvs();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllEnvs();
});

describe("isAuthorizedCron — production fails closed", () => {
  it("DENIES when CRON_SECRET is unset in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it("DENIES a caller that presents no secret when one is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req())).toBe(false);
  });

  it("DENIES a wrong secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req(undefined, { authorization: "Bearer nope" }))).toBe(false);
  });

  it("DENIES a secret that is a prefix of the real one (length must match)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret-value");
    expect(isAuthorizedCron(req(undefined, { authorization: "Bearer s3cret" }))).toBe(false);
  });

  it("ALLOWS the exact bearer secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req(undefined, { authorization: "Bearer s3cret" }))).toBe(true);
  });

  it("accepts a case-insensitive Bearer scheme and surrounding whitespace", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req(undefined, { authorization: "bearer   s3cret  " }))).toBe(true);
  });
});

describe("isAuthorizedCron — query secrets are rejected", () => {
  it("IGNORES ?key= even when the value is correct", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req("https://app.test/api/cron?key=s3cret"))).toBe(false);
  });

  it("IGNORES ?secret=", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req("https://app.test/api/va/scan?secret=s3cret"))).toBe(false);
  });
});

describe("isAuthorizedCron — development stays open", () => {
  it("ALLOWS when no secret is configured outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isAuthorizedCron(req())).toBe(true);
  });

  it("still DENIES a wrong secret outside production once one is configured", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(isAuthorizedCron(req(undefined, { authorization: "Bearer nope" }))).toBe(false);
  });

  it("can be forced closed for tests via allowUnauthenticatedInDev: false", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isAuthorizedCron(req(), { allowUnauthenticatedInDev: false })).toBe(false);
  });
});

describe("isAuthorizedBackfill — accepts either secret", () => {
  it("ALLOWS BACKFILL_SECRET", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BACKFILL_SECRET", "bf");
    expect(isAuthorizedBackfill(req(undefined, { authorization: "Bearer bf" }))).toBe(true);
  });

  it("ALLOWS CRON_SECRET as the fallback", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "cron");
    expect(isAuthorizedBackfill(req(undefined, { authorization: "Bearer cron" }))).toBe(true);
  });

  it("DENIES when neither is configured in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isAuthorizedBackfill(req())).toBe(false);
  });
});

describe("route guards", () => {
  it("requireCronAuth returns 401 with a config hint when production has no secret", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = requireCronAuth(req());
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string; reason?: string };
    expect(body.error).toBe("Unauthorized");
    expect(body.reason).toContain("CRON_SECRET");
  });

  it("requireCronAuth returns 401 without the config hint for a bad guess", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    const res = requireCronAuth(req(undefined, { authorization: "Bearer nope" }));
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { reason?: string };
    expect(body.reason).toBeUndefined();
  });

  it("requireCronAuth returns null (let the handler run) for a valid secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(requireCronAuth(req(undefined, { authorization: "Bearer s3cret" }))).toBeNull();
  });

  it("requireBackfillAuth returns a 401 naming BACKFILL_SECRET", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const res = requireBackfillAuth(req());
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { reason?: string };
    expect(body.reason).toContain("BACKFILL_SECRET");
  });
});

describe("cronSecret", () => {
  it("trims whitespace so a trailing newline in a dashboard paste still matches", () => {
    vi.stubEnv("CRON_SECRET", "  s3cret\n");
    expect(cronSecret()).toBe("s3cret");
  });

  it("returns an empty string when unset", () => {
    expect(cronSecret()).toBe("");
  });
});
