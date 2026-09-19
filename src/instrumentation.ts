export async function register() {
  // Only run in the Node.js runtime, not Edge.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const port = process.env.PORT ?? "3000";
  const base = `http://localhost:${port}`;
  const secret = (process.env.CRON_SECRET ?? "").trim();

  const FIRST_DELAY_MS = 30_000;
  const INTERVAL_MS = 60 * 60 * 1000;

  const runOnce = async () => {
    try {
      const res = await fetch(`${base}/api/cron/settle`, {
        method: "POST",
        headers: secret
          ? { Authorization: `Bearer ${secret}` }
          : undefined,
      });
      const body = await res.text();
      console.log(
        `[instrumentation] settle → HTTP ${res.status} ${body.slice(0, 200)}`
      );
    } catch (err) {
      console.error("[instrumentation] settle failed:", err);
    }
  };

  setTimeout(() => {
    void runOnce();
    setInterval(() => void runOnce(), INTERVAL_MS);
  }, FIRST_DELAY_MS);

  console.log(
    "[instrumentation] settle scheduler started — first run in 30s, then every 60m"
  );
}
