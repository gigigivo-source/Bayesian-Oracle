"use client";

// Ranking Mode Performance has an explicit route so links from the app menu
// land on the same dashboard shown by the performance navigation.
import { Suspense } from "react";
import { ModesDashboard } from "@/app/_components/perf/ModesDashboard";
import { DashboardSkeleton } from "@/app/_components/perf/modes";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";

export default function RankingModePerformancePage() {
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
        <ModesDashboard />
      </PerformanceShell>
    </Suspense>
  );
}
