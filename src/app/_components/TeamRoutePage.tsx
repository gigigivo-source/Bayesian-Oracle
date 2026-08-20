"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type TeamProfileResponse = {
  team?: string;
  league?: string;
  profile?: unknown;
  providers?: string[];
  providerCount?: number;
  samples?: number;
  error?: string;
};

export function TeamRoutePage({
  teamSlug,
  teamName,
  leagueSlug,
}: {
  teamSlug: string;
  teamName?: string;
  leagueSlug?: string;
}) {
  const displayName = teamName || teamSlug.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
  const league = leagueSlug || "eng.1";
  const [data, setData] = useState<TeamProfileResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/team-profile?team=${encodeURIComponent(displayName)}&league=${encodeURIComponent(league)}`)
      .then((response) => response.json() as Promise<TeamProfileResponse>)
      .then((response) => { if (!cancelled) setData(response); })
      .catch(() => { if (!cancelled) setData({ error: "Unable to load team data." }); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [displayName, league]);

  return (
    <div className="min-h-screen bg-[#05070d] text-slate-100">
      <header className="sticky top-0 z-40 bg-black/60 shadow-lg backdrop-blur-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-2">
          <Link href="/" className="font-mono text-lg font-extrabold text-amber-300">ĞIGI GIVØ</Link>
          <Link
            href={`/leagues/${encodeURIComponent(league)}`}
            className="rounded-md border border-white/15 bg-white/10 px-4 py-1.5 text-sm font-medium text-slate-100 hover:bg-white/20"
          >
            ✕ Close
          </Link>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8 space-y-6">
        <div className="bg-black/50 rounded-lg p-5">
          <div className="text-[10px] uppercase tracking-wider text-amber-300 font-mono">Team Profile</div>
          <h1 className="text-2xl font-extrabold text-white mt-1">{displayName}</h1>
          <p className="text-xs text-slate-400 font-mono mt-1">League: {league}</p>
        </div>

        {loading ? (
          <div className="bg-black/50 rounded-lg p-10 text-center text-amber-300 font-mono animate-pulse">Loading team data…</div>
        ) : data?.error ? (
          <div className="bg-black/50 rounded-lg p-8 text-center">
            <div className="text-sm font-bold text-slate-300 mb-2">No profile data available</div>
            <p className="text-xs text-slate-400 font-mono">{data.error}</p>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="bg-black/50 rounded-lg p-4 text-center">
                <div className="text-2xl font-extrabold font-mono text-amber-300">{data?.providerCount ?? 0}</div>
                <div className="text-[10px] text-slate-400">Data Providers</div>
              </div>
              <div className="bg-black/50 rounded-lg p-4 text-center">
                <div className="text-2xl font-extrabold font-mono text-emerald-300">{data?.samples ?? 0}</div>
                <div className="text-[10px] text-slate-400">Match Samples</div>
              </div>
              <div className="bg-black/50 rounded-lg p-4 text-center col-span-2 sm:col-span-1">
                <div className="text-sm font-bold text-cyan-300 truncate">{data?.providers?.join(" · ") || "Data mesh"}</div>
                <div className="text-[10px] text-slate-400 mt-1">Sources</div>
              </div>
            </div>
            <div className="bg-black/50 rounded-lg p-4 overflow-x-auto">
              <div className="text-xs font-bold text-white font-mono mb-3">STATISTICAL PROFILE</div>
              <pre className="text-[11px] leading-relaxed text-slate-300 font-mono whitespace-pre-wrap">
                {JSON.stringify(data?.profile, null, 2)}
              </pre>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
