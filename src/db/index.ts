import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

export const pool =
  globalForDb.__arenaNextJsPostgresqlPool ??
  new Pool({
    connectionString: databaseUrl,
    // Without these, an unreachable or overloaded database makes every query
    // hang on the OS-level TCP timeout. `/api/auth` gates the entire UI, so a
    // slow pool literally means a blank screen for minutes.
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS ?? 10_000),
    statement_timeout:       Number(process.env.PGSTATEMENT_TIMEOUT_MS ?? 15_000),
    idle_in_transaction_session_timeout: 15_000,
    // Neon closes idle connections aggressively. Recycle our idle clients
    // before Neon does (20s) and keep the TCP socket warm so long-running
    // scans (4-6 min) don't come back to a dead connection.
    idleTimeoutMillis:       20_000,
    max:                     Number(process.env.PGPOOL_MAX ?? 5),
    keepAlive:               true,
    keepAliveInitialDelayMillis: 10_000,
  });

// A pool-level error (e.g. the server dropping an idle connection) is emitted
// as an 'error' event; with no listener Node treats it as an uncaught exception
// and tears the process down. Guarded so dev HMR doesn't stack listeners.
if (pool.listenerCount("error") === 0) {
  pool.on("error", (err) => {
    console.error("[db] idle client error", err.message);
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForDb.__arenaNextJsPostgresqlPool = pool;
}

export const db = drizzle(pool);

/**
 * Cheap round-trip used to keep a pooled connection warm during long-running
 * work (e.g. the 4-6 minute VA scan). Errors are swallowed on purpose: a failed
 * ping just means the pool will open a fresh connection on the next real query.
 */
export async function keepDbAlive(): Promise<void> {
  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    /* ignore */
  }
}
