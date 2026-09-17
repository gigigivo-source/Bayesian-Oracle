// POST /api/va/scan — background job mode (PHASE 4).
//
//   ?background=true  → claim a va_scan_lock row (status='running'), fire the
//                       scan WITHOUT awaiting, answer { ok:true, status:"started" }
//                       in about a second
//   a running job     → 409 { ok:false, error:"a scan is already running" }
//   a job older than  → stale, so it does not block: the new scan starts
//   15 minutes
//   no ?background    → unchanged: await the scan and return its body
//
// performScan is mocked (it has its own suite) and @/db is an in-memory fake, so
// no scan work, no network and no Postgres are involved.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// vi.mock calls below are hoisted above this import by vitest.
import { POST } from "./route";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ── In-memory va_scan_lock ───────────────────────────────────────────────────
// The fake ignores WHERE/ORDER BY (drizzle SQL objects are not evaluable here),
// so each test seeds exactly the rows its scenario needs and rows come back
// newest-first. That is deliberate: it puts the 15-minute staleness rule under
// test in the JS that re-applies it (scanLock.findRunningScanLock) instead of in
// SQL the fake could not honour anyway.
const h = vi.hoisted(() => ({
  lockRows: [] as Array<Record<string, unknown>>,
  nextId: 0,
  scanDelayMs: 1500,
  scanResult: { status: 200, body: { ok: true } } as { status: number; body: Record<string, unknown> },
}));

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        h.nextId += 1;
        h.lockRows.push({ id: h.nextId, ...row });
        return Promise.resolve([]);
      },
    }),
    select: () => ({
      from: () => {
        const rows = [...h.lockRows].sort((a, b) => Number(b.id) - Number(a.id));
        const self: Record<string, unknown> = {};
        self.where = () => self;
        self.orderBy = () => self;
        self.limit = () => self;
        self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(rows).then(resolve, reject);
        return self;
      },
    }),
    delete: () => {
      const self: Record<string, unknown> = {};
      self.where = () => Promise.resolve([]);
      self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject);
      return self;
    },
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          // updateScanLock patches by scan id, and the route includes that id in
          // the patch; fall back to the newest row when it does not.
          const scanId = typeof patch.scanId === "string" ? patch.scanId : null;
          const target = scanId
            ? h.lockRows.find((row) => row.scanId === scanId)
            : h.lockRows[h.lockRows.length - 1];
          if (target) Object.assign(target, patch);
          return Promise.resolve([]);
        },
      }),
    }),
  },
  keepDbAlive: async () => undefined,
}));

const performScan = vi.fn();
vi.mock("@/lib/va/performScan", () => ({
  performScan: (mode: string, finished: boolean, opts?: Record<string, unknown>) =>
    performScan(mode, finished, opts),
}));

function post(query: string, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost/api/va/scan${query}`, { method: "POST", headers });
}

/** Seed a va_scan_lock row the way acquireScanLock writes one. */
function seedLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  h.nextId += 1;
  const row: Record<string, unknown> = {
    id: h.nextId,
    scanId: `va_seed_${h.nextId}`,
    lockedAt: new Date(),
    status: "running",
    mode: "stack",
    startedAt: new Date(),
    completedAt: null,
    error: null,
    ...overrides,
  };
  h.lockRows.push(row);
  return row;
}

beforeEach(() => {
  h.lockRows.length = 0;
  h.nextId = 0;
  h.scanDelayMs = 1500;
  h.scanResult = { status: 200, body: { ok: true, scanId: "va_from_scan" } };
  performScan.mockReset();
  performScan.mockImplementation(async (_mode: string, _finished: boolean, opts?: { scanId?: string }) => {
    await sleep(h.scanDelayMs);
    return { ...h.scanResult, body: { ...h.scanResult.body, scanId: opts?.scanId ?? "va_from_scan" } };
  });
  vi.stubEnv("CRON_SECRET", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("POST /api/va/scan?background=true", () => {
  it("12. returns in under 500ms while the scan keeps running detached", async () => {
    const startedAt = Date.now();
    const res = await POST(post("?mode=stack&finished=true&background=true"));
    const elapsed = Date.now() - startedAt;
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, status: "started" });
    // The scan itself takes 1500ms; answering in <500ms proves it was not awaited.
    expect(elapsed).toBeLessThan(500);
    expect(h.scanDelayMs).toBeGreaterThan(elapsed);

    // The lock row was claimed BEFORE the response went out.
    expect(h.lockRows).toHaveLength(1);
    expect(h.lockRows[0]).toMatchObject({ status: "running", mode: "backtest" });
    expect(h.lockRows[0].scanId).toMatch(/^va_\d+_[0-9a-f]{8}$/);
    expect(performScan).toHaveBeenCalledTimes(1);
    expect(performScan.mock.calls[0][0]).toBe("stack");
    expect(performScan.mock.calls[0][1]).toBe(true);
    // Told the lock is already held, and handed the id the row was written with.
    expect(performScan.mock.calls[0][2]).toEqual({ scanId: h.lockRows[0].scanId, lockHeld: true });

    // …and the detached job publishes its outcome to that same row.
    await vi.waitFor(() => expect(h.lockRows[0].status).toBe("done"), { timeout: 5000, interval: 25 });
    expect(h.lockRows[0].completedAt).toBeInstanceOf(Date);
    expect(h.lockRows[0].scanId).toMatch(/^va_/);
  });

  it("12b. the live (unfinished) background scan needs the CRON_SECRET and records mode=stack", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");

    const unauthenticated = await POST(post("?mode=stack&background=true"));
    expect(unauthenticated.status).toBe(401);
    expect(performScan).not.toHaveBeenCalled();

    const authenticated = await POST(
      post("?mode=stack&background=true", { Authorization: "Bearer s3cret" }),
    );
    expect(authenticated.status).toBe(200);
    expect(await authenticated.json()).toEqual({ ok: true, status: "started" });
    expect(h.lockRows[0]).toMatchObject({ status: "running", mode: "stack" });
  });

  it("12c. without ?background the route still awaits and returns the scan body", async () => {
    h.scanDelayMs = 300;
    const startedAt = Date.now();
    const res = await POST(post("?mode=stack&finished=true"));
    const elapsed = Date.now() - startedAt;
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(300); // it really waited
    expect(performScan).toHaveBeenCalledTimes(1);
    expect(performScan.mock.calls[0][0]).toBe("stack");
    expect(performScan.mock.calls[0][1]).toBe(true);
    // No options: the foreground path acquires and releases its own lock row.
    expect(performScan.mock.calls[0][2]).toBeUndefined();
    expect(h.lockRows).toHaveLength(0);
  });

  it("13. returns 409 when a job started inside the last 15 minutes is still running", async () => {
    seedLock({ startedAt: new Date(Date.now() - 2 * 60 * 1000), lockedAt: new Date(Date.now() - 2 * 60 * 1000) });

    const res = await POST(post("?mode=stack&finished=true&background=true"));
    const body = (await res.json()) as Record<string, unknown>;

    expect(res.status).toBe(409);
    expect(body).toEqual({ ok: false, error: "a scan is already running" });
    expect(performScan).not.toHaveBeenCalled();
    expect(h.lockRows).toHaveLength(1); // no second job was claimed
  });

  it("13b. a running row older than 15 minutes is stale: it does not block, and the new job is claimed", async () => {
    const stale = seedLock({
      startedAt: new Date(Date.now() - 20 * 60 * 1000),
      lockedAt: new Date(Date.now() - 20 * 60 * 1000),
    });

    const res = await POST(post("?mode=stack&finished=true&background=true"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "started" });
    expect(performScan).toHaveBeenCalledTimes(1);
    // The stale row was overwritten by a fresh one for the new scan id.
    expect(h.lockRows.length).toBeGreaterThanOrEqual(1);
    const fresh = h.lockRows[h.lockRows.length - 1];
    expect(fresh.status).toBe("running");
    expect(fresh.scanId).not.toBe(stale.scanId);
  });

  it("13c. a COMPLETED job does not block a new one (history is not a lock)", async () => {
    seedLock({
      status: "done",
      startedAt: new Date(Date.now() - 60 * 1000),
      completedAt: new Date(Date.now() - 30 * 1000),
    });

    const res = await POST(post("?mode=stack&finished=true&background=true"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: "started" });
    expect(performScan).toHaveBeenCalledTimes(1);
  });

  it("13d. a scan that reports ok:false is published as an error, not as done", async () => {
    h.scanDelayMs = 50;
    h.scanResult = { status: 500, body: { ok: false, reason: "scan failed", error: "Error: boom" } };

    const res = await POST(post("?mode=stack&finished=true&background=true"));
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(h.lockRows[0].status).toBe("error"), { timeout: 3000, interval: 25 });
    expect(h.lockRows[0].error).toBe("scan failed: Error: boom");
    expect(h.lockRows[0].completedAt).toBeInstanceOf(Date);
  });

  it("13e. a scan that THROWS is published as an error too", async () => {
    h.scanDelayMs = 10;
    performScan.mockImplementation(async () => {
      await sleep(h.scanDelayMs);
      throw new Error("detached explosion");
    });

    const res = await POST(post("?mode=stack&finished=true&background=true"));
    expect(res.status).toBe(200);

    await vi.waitFor(() => expect(h.lockRows[0].status).toBe("error"), { timeout: 3000, interval: 25 });
    expect(String(h.lockRows[0].error)).toContain("detached explosion");
  });
});
