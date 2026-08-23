"use client";

// ĞIGI GIVØ — Performance home.
// Default view is the four-mode ranking dashboard (Classic A, 12-Factor B,
// Hybrid C, Consensus D). League-level breakdown lives at /performance/leagues.

import { Suspense } from "react";
import { PerformanceShell } from "@/app/_components/perf/PerformanceShell";
import { DashboardSkeleton } from "@/app/_components/perf/modes";
import { ModesDashboard } from "@/app/_components/perf/ModesDashboard";

export default function PerformancePage() {
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
