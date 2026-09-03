"use client";

// Ranking Mode Performance has an explicit route so links from the app menu
// land on the same dashboard shown by the performance navigation.
import { Suspense, useCallback, useState } from "react";
import { ModesDashboard } from "@/app/_components/perf/ModesDashboard";
import { DashboardSkeleton } from "@/app/_components/perf/modes";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";

export const dynamic = "force-dynamic";

export default function RankingModePerformancePage() {
  const [refreshing, setRefreshing] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    setRefreshError(null);
    try {
      // Force fresh calculation on server - bypasses 1-hour cache
      const res = await fetch("/api/performance/modes?refresh=true&days=30", {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`Refresh failed with ${res.status}`);
      }
      // Trigger reload of dashboard to show fresh data
      // Dashboard will fetch again and get the newly cached fresh result instantly
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setRefreshError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, []);

  return (
    <Suspense
      fallback={
        <PerformanceShell title="Ranking Mode Performance" subtitle="Loading…">
          <DashboardSkeleton />
        </PerformanceShell>
      }
    >
      <PerformanceShell
        title="Ranking Mode Performance"
        subtitle="Full-detail, auditable track record for every ranking mode — Classic A, 12-Factor B, Hybrid C and Consensus D. Pick a chip to filter the entire page. Every number is a plain sum over the settled bets behind it."
      >
        {/* Refresh button - pill-shaped, near title / top right of data section */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-slate-500">
              Cached for 1 hour · Instant reload within hour
            </span>
          </div>
          <div className="flex items-center gap-2">
            {refreshError && (
              <span className="text-xs text-rose-300">{refreshError}</span>
            )}
            <button
              type="button"
              onClick={() => void handleRefresh()}
              disabled={refreshing}
              className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-slate-800 px-4 py-2 text-xs font-semibold text-slate-200 shadow-inner shadow-black/20 transition hover:bg-slate-700 hover:text-white disabled:opacity-60"
              aria-label="Refresh ranking mode performance"
            >
              {refreshing ? (
                <>
                  <span className="h-3 w-3 animate-spin rounded-full border-2 border-slate-400 border-t-white" />
                  Refreshing…
                </>
              ) : (
                <>🔄 Refresh</>
              )}
            </button>
          </div>
        </div>

        {refreshing && (
          <div className="flex items-center gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-400/30 border-t-amber-300" />
            Forcing fresh calculation, ignoring 1-hour cache…
          </div>
        )}

        {/* Key forces remount to fetch fresh data after refresh */}
        <ModesDashboard key={refreshKey} />
      </PerformanceShell>
    </Suspense>
  );
}
