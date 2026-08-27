export function EmptyState({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 px-8 py-14 text-center shadow-[0_0_60px_-20px_rgba(6,182,212,0.55)]">
      <div className="relative mx-auto mb-6 h-24 w-24">
        <div className="absolute inset-0 rounded-full border-2 border-cyan-400/30 motion-safe:animate-ping" />
        <div className="absolute inset-1 rounded-full border border-cyan-300/50 shadow-[0_0_28px_rgba(6,182,212,0.7)]" />
        <div className="relative flex h-full items-center justify-center text-4xl">⏱️</div>
      </div>
      <h2 className="text-xl font-bold text-cyan-50">
        No matches in the next 7 days with available data. Check back soon!
      </h2>
      <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-slate-400">
        First 5 minutes markets will appear here when matches are scheduled.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-6 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-cyan-400 to-teal-400 px-5 py-2 text-xs font-bold text-white shadow-lg shadow-cyan-500/30 transition-all duration-300 hover:scale-105 active:scale-95"
      >
        🔄 Refresh
      </button>
    </div>
  );
}
