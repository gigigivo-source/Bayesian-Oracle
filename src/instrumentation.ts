export async function register() {
  // Only run in the Node.js runtime, not Edge
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  // Wait 30 seconds after boot so the server is fully ready
  // before we start hitting the DB.
  const FIRST_DELAY_MS = 30_000;
  // Run settle every 60 minutes.
  const INTERVAL_MS = 60 * 60 * 1000;

  console.log(
    "[instrumentation] settle scheduler started — first run in 30s, then every 60m",
  );

  // Import lazily to avoid pulling DB code during Edge runtime
  // warmup if the runtime check above ever misses.
  const runOnce = async () => {
    try {
      const { settleFeaturePicks } = await import(
        "@/app/api/cron/settle/route"
      );
      const { runSettlementEngine } = await import("@/lib/settlement/engine");
      const engine = await runSettlementEngine();
      const featurePicks = await settleFeaturePicks(false);
      console.log(
        `[instrumentation] settle: engine=${JSON.stringify(engine)} ` +
          `features=${JSON.stringify(featurePicks)}`,
      );
    } catch (err) {
      console.error("[instrumentation] settle failed:", err);
    }
  };

  setTimeout(() => {
    void runOnce();
    setInterval(() => void runOnce(), INTERVAL_MS);
  }, FIRST_DELAY_MS);
}
