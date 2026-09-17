// GET /api/va/tickets/status — the background-job status endpoint (PHASE 5).
//
// Reads the latest va_scan_lock row and normalises it for the page:
//   { running, mode, startedAt, completedAt, scanId, error, elapsedSeconds }
// No auth (it exposes nothing but job state), and a stale 'running' row — a job
// whose process died, older than 15 minutes — is reported as NOT running so the
// page stops polling it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  lockRows: [] as Array<Record<string, unknown>>,
  failReads: false,
}));

vi.mock("@/db", () => {
  const fakeDb = {
    select: () => ({
      from: () => {
        const rows = [...h.lockRows].sort((a, b) => Number(b.id) - Number(a.id));
        const self: Record<string, unknown> = {};
        self.where = () => self;
        self.orderBy = () => self;
        self.limit = () => self;
        self.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          h.failReads
            ? Promise.reject(new Error("simulated db failure")).then(resolve, reject)
            : Promise.resolve(rows).then(resolve, reject);
        return self;
      },
    }),
  };
  return { db: fakeDb, keepDbAlive: async () => undefined };
});

// @/lib/va/scanLock and @/db/schema stay real: the staleness/normalisation rules
// under test live there.
import { GET } from "./route";
import type { VaScanStatusBody } from "./route";

let nextId = 0;
function seedLock(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  nextId += 1;
  const row: Record<string, unknown> = {
    id: nextId,
    scanId: `va_${nextId}_abcdef01`,
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

async function getStatus(): Promise<{ status: number; body: VaScanStatusBody }> {
  const res = await GET();
  return { status: res.status, body: (await res.json()) as VaScanStatusBody };
}

beforeEach(() => {
  h.lockRows.length = 0;
  h.failReads = false;
  nextId = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/va/tickets/status", () => {
  it("14. reports running=true (with mode and elapsed) while a job is in flight", async () => {
    const startedAt = new Date(Date.now() - 30_000);
    seedLock({ scanId: "va_123_deadbeef", status: "running", mode: "stack", startedAt, lockedAt: startedAt });

    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body).toEqual({
      running: true,
      mode: "stack",
      startedAt: startedAt.toISOString(),
      completedAt: null,
      scanId: "va_123_deadbeef",
      error: null,
      elapsedSeconds: expect.any(Number),
    });
    expect(body.elapsedSeconds).toBeGreaterThanOrEqual(29);
    expect(body.elapsedSeconds).toBeLessThanOrEqual(45);
  });

  it("14b. reports the backtest flavour so the backtest chip can match its own job", async () => {
    seedLock({ status: "running", mode: "backtest" });

    const { body } = await getStatus();

    expect(body.running).toBe(true);
    expect(body.mode).toBe("backtest");
  });

  it("14c. flips to running=false with completedAt and a closed elapsed window when the job finishes", async () => {
    const startedAt = new Date(Date.now() - 5 * 60 * 1000);
    const completedAt = new Date(Date.now() - 20 * 1000);
    seedLock({ status: "done", mode: "stack", startedAt, completedAt, lockedAt: startedAt });

    const { body } = await getStatus();

    expect(body.running).toBe(false);
    expect(body.error).toBeNull();
    expect(body.completedAt).toBe(completedAt.toISOString());
    // Elapsed is measured to completion, not to now.
    expect(body.elapsedSeconds).toBe(Math.round((completedAt.getTime() - startedAt.getTime()) / 1000));
  });

  it("14d. surfaces the failure reason of an errored job", async () => {
    seedLock({
      status: "error",
      mode: "backtest",
      error: "scan failed: Error: boom",
      completedAt: new Date(),
    });

    const { body } = await getStatus();

    expect(body.running).toBe(false);
    expect(body.error).toBe("scan failed: Error: boom");
    expect(body.mode).toBe("backtest");
  });

  it("14e. a 'running' row older than 15 minutes is stale → running=false", async () => {
    const startedAt = new Date(Date.now() - 20 * 60 * 1000);
    seedLock({ status: "running", mode: "stack", startedAt, lockedAt: startedAt });

    const { body } = await getStatus();

    expect(body.running).toBe(false);
    expect(body.mode).toBe("stack"); // still reported: it is the latest row
    expect(body.error).toBeNull();
  });

  it("14f. reports the latest row, not an older one", async () => {
    seedLock({ scanId: "va_old_11111111", status: "done", mode: "stack", completedAt: new Date(Date.now() - 60_000) });
    seedLock({ scanId: "va_new_22222222", status: "running", mode: "backtest" });

    const { body } = await getStatus();

    expect(body.scanId).toBe("va_new_22222222");
    expect(body.running).toBe(true);
    expect(body.mode).toBe("backtest");
  });

  it("14g. an empty lock table is a full idle payload", async () => {
    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body).toEqual({
      running: false,
      mode: null,
      startedAt: null,
      completedAt: null,
      scanId: null,
      error: null,
      elapsedSeconds: null,
    });
  });

  it("14h. a legacy row (no status, fresh locked_at) still reads as running", async () => {
    // Rows written before drizzle/0008 — or by a foreground scan on a database
    // where the new columns are missing — carry only locked_at + scan_id.
    seedLock({ status: null, mode: null, startedAt: null, lockedAt: new Date(Date.now() - 10_000) });

    const { body } = await getStatus();

    expect(body.running).toBe(true);
    expect(body.mode).toBeNull();
    expect(body.startedAt).not.toBeNull();
    expect(body.elapsedSeconds).toBeGreaterThanOrEqual(9);
  });

  it("14i. fails soft: an unreadable lock table is an idle payload, not a 500", async () => {
    seedLock({ status: "running", mode: "stack" });
    h.failReads = true;

    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body.running).toBe(false);
    // mode=null means the page keeps polling rather than mistaking this for a
    // finished job (it only stops on a mode match).
    expect(body.mode).toBeNull();
  });
});
