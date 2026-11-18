import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { sql } from "drizzle-orm";

type DbClient = ReturnType<typeof drizzle>;

const globalForDb = globalThis as typeof globalThis & {
  __arenaNextJsPostgresqlPool?: Pool;
};

let cachedDb: DbClient | undefined;

function createPool(connectionString: string): Pool {
  const pool = new Pool({
    connectionString,
    // Without these, an unreachable or overloaded database makes every query
    // hang on the OS-level TCP timeout. A missing or slow database must never
    // block route-module imports or static rendering.
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
  return pool;
}

function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Deferred on purpose: importing a route must not crash the whole build or
    // public page render in environments where no database is configured.
    throw new Error("DATABASE_URL is required");
  }

  let pool = globalForDb.__arenaNextJsPostgresqlPool;
  if (!pool) {
    pool = createPool(databaseUrl);
    globalForDb.__arenaNextJsPostgresqlPool = pool;
  }
  return pool;
}

function getDb(): DbClient {
  if (cachedDb) return cachedDb;
  cachedDb = drizzle(getPool());
  return cachedDb;
}

/**
 * Build a lazy handle that only resolves the real client on first property
 * access (i.e. when a query or pool method is actually used). Methods are bound
 * to the real client so Drizzle's internal `this` usage keeps working.
 */
function lazyClient<T extends object>(getClient: () => T): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      // Never make the proxy look like a thenable; `await db` / `await pool`
      // must not trigger a connection or obscure the real client.
      if (prop === "then") return undefined;
      const client = getClient();
      const value: unknown = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  });
}

/**
 * Lazy database handles. Importing this module never connects to Postgres and
 * never throws when DATABASE_URL is unset; the error is raised only when a
 * query actually touches `db` or `pool`.
 */
export const pool: Pool = lazyClient(getPool);
export const db: DbClient = lazyClient(getDb);

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
