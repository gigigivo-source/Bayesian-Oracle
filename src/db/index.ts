import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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
    connectionTimeoutMillis: Number(process.env.PGCONNECT_TIMEOUT_MS ?? 5_000),
    statement_timeout:       Number(process.env.PGSTATEMENT_TIMEOUT_MS ?? 15_000),
    idle_in_transaction_session_timeout: 15_000,
    idleTimeoutMillis:       30_000,
    max:                     Number(process.env.PGPOOL_MAX ?? 10),
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
