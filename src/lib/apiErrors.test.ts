import { afterEach, describe, expect, it, vi } from "vitest";
import { apiError, errorMessage, withRouteErrors } from "./apiErrors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("apiError", () => {
  it("returns descriptive JSON with the original error details", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = apiError("Database query failed", new Error("connection refused"));

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Database query failed",
      details: "connection refused",
    });
    expect(log).toHaveBeenCalled();
  });

  it("keeps a custom status and extra fields without a cause", async () => {
    const response = apiError("Service unavailable", undefined, 503, { ok: false });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Service unavailable",
      ok: false,
    });
  });
});

describe("withRouteErrors", () => {
  it("converts an unhandled rejection into a labeled 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const handler = withRouteErrors(async () => {
      throw new Error("connection refused");
    }, "GET /api/example");

    const response = await handler();
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "GET /api/example failed",
      details: "connection refused",
    });
    expect(log).toHaveBeenCalled();
  });
});

describe("errorMessage", () => {
  it("stringifies non-Error thrown values", () => {
    expect(errorMessage("plain failure")).toBe("plain failure");
    expect(errorMessage(undefined)).toBe("undefined");
    expect(errorMessage({ code: "ECONNRESET" })).toBe('{"code":"ECONNRESET"}');
  });
});
