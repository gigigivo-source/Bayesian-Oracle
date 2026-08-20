"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FixtureLite } from "@/lib/espn";
import { ErrorBoundary } from "./ErrorBoundary";
import { MatchDetail } from "./MatchDetail";

export function FixtureRoutePage({
  eventId,
  leagueSlug,
  familyFilter,
  showJson,
  liveTab,
}: {
  eventId: string;
  leagueSlug?: string;
  familyFilter?: string;
  showJson?: boolean;
  liveTab?: "events" | "stats" | "commentary";
}) {
  const [fixture, setFixture] = useState<FixtureLite | null>(null);
  const [loading, setLoading] = useState(Boolean(leagueSlug));
  const [error, setError] = useState<string | null>(
    leagueSlug ? null : "The fixture link is missing its league. Return to the fixture browser and select the match again.",
  );

  useEffect(() => {
    if (!leagueSlug) return;
    let cancelled = false;
    fetch(`/api/fixtures?league=${encodeURIComponent(leagueSlug)}&event=${encodeURIComponent(eventId)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<{ fixture?: FixtureLite | null; fixtures?: FixtureLite[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        const match = data.fixture ?? data.fixtures?.find((item) => item.id === eventId) ?? null;
        setFixture(match);
        setError(match ? null : "This fixture is no longer available in the current schedule window.");
      })
      .catch(() => {
        if (!cancelled) setError("Unable to load this fixture. Please return to the league page and try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [eventId, leagueSlug]);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#05070d] flex items-center justify-center">
        <div className="text-amber-300 font-mono animate-pulse">Loading fixture…</div>
      </div>
    );
  }

  if (!fixture || error) {
    return (
      <div className="min-h-screen bg-[#05070d] flex items-center justify-center px-4">
        <div className="bg-black/50 rounded-lg p-8 text-center max-w-lg">
          <div className="text-lg font-bold text-slate-200 mb-2">Fixture unavailable</div>
          <p className="text-sm text-slate-400 font-mono mb-5">{error}</p>
          <Link
            href={leagueSlug ? `/leagues/${encodeURIComponent(leagueSlug)}` : "/leagues"}
            className="rounded-lg bg-amber-400/20 border border-amber-400/30 px-4 py-2 text-xs font-bold text-amber-300 hover:bg-amber-400/30 transition"
          >
            Back to fixtures
          </Link>
        </div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <MatchDetail
        fixture={fixture}
        familyFilter={familyFilter}
        showJson={showJson}
        liveTab={liveTab}
      />
    </ErrorBoundary>
  );
}
