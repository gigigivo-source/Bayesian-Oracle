// ─────────────────────────────────────────────────────────────────────────────
// ĞIGI GIVØ — Interactive Design System
//
// One central source of truth for every clickable element in the app.
// Refined Sports Analytics palette:
//   · Active tabs & primary CTAs: Amber/Gold (#F59E0B → #FF8C00)
//   · Secondary CTAs: Cyan (#06B6D4)
//   · Backgrounds: Deep slate (#0F1117, #1E293B)
//   · Text: White for active states, Slate-400 for inactive states
//   · No glass-morphism: solid slate surfaces and borders only
//
// Global interaction rules baked into every token:
//   · cursor-pointer + select-none
//   · smooth transitions (transition-all duration-200)
//   · visible keyboard focus rings (accessibility)
//
// Visual layer only — no behaviour or routing lives here.
// ─────────────────────────────────────────────────────────────────────────────

/** Shared interaction baseline required by every clickable element. */
const IX = "cursor-pointer select-none transition-all duration-200 tap-target";
const GOLD_GRADIENT = "bg-gradient-to-r from-[#F59E0B] to-[#FF8C00]";

/* ═══ TYPE 1 · PRIMARY NAVIGATION — solid slate pills ══════════════════════ */

export const NAV_PILL =
  `${IX} chip-responsive inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/70";

/** Inactive pill: solid slate, muted text, slight elevation. */
export const NAV_PILL_OFF =
  "border border-slate-700 bg-slate-800 text-slate-400 shadow-sm hover:bg-slate-700 hover:text-white";

/** Active pill (main app): amber/gold gradient with a coloured glow. */
export const NAV_PILL_ON_AMBER =
  `scale-105 ${GOLD_GRADIENT} font-bold text-white shadow-lg shadow-amber-500/40`;

/** Active pill (performance section): same refined amber/gold active-tab palette. */
export const NAV_PILL_ON_VIOLET = NAV_PILL_ON_AMBER;

/* ═══ TYPE 2 · PRIMARY ACTION BUTTONS — gold/amber CTAs ═══════════════════ */

const ACTION =
  `${IX} btn-responsive rounded-lg font-bold shadow-lg hover:scale-105 active:scale-95 ` +
  "hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0F1117] " +
  "disabled:pointer-events-none disabled:opacity-50";

const ACTION_GOLD =
  `${ACTION} ${GOLD_GRADIENT} text-white shadow-amber-500/30 focus:ring-amber-300`;

/** Success actions: Verify, Save, Run Backtest, Re-verify, Track confirmation. */
export const ACTION_EMERALD = ACTION_GOLD;

/** Brand actions: Send, Convert, Add, Start Tracking, Track Slip, Set PIN. */
export const ACTION_AMBER = ACTION_GOLD;

/** Info actions: Retry, Try Again, Resolve Pending (Web Search). */
export const ACTION_BLUE = ACTION_GOLD;

/** Destructive primary actions (rare). */
export const ACTION_ROSE = ACTION_GOLD;

/* ═══ TYPE 3 · SECONDARY / OUTLINE BUTTONS — cyan on slate ════════════════ */

const OUTLINE =
  `${IX} btn-responsive rounded-lg border bg-transparent font-bold ` +
  "hover:scale-105 active:scale-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#0F1117]";

/** Default secondary: Back / Cancel / Reset / Refresh. */
export const OUTLINE_CYAN =
  `${OUTLINE} border-[#06B6D4] text-[#06B6D4] hover:bg-slate-800 hover:text-white focus:ring-cyan-300`;

/** Accent secondary: open-page / jump-to-destination actions. */
export const OUTLINE_AMBER = OUTLINE_CYAN;

/** Destructive secondary: Delete, cancel-edit. */
export const OUTLINE_ROSE =
  `${OUTLINE} border-rose-400 text-rose-300 hover:bg-slate-800 hover:text-white focus:ring-rose-300`;

/** Neutral secondary: Close, JSON export, dismiss banners. */
export const OUTLINE_NEUTRAL =
  `${OUTLINE} border-slate-700 text-slate-400 hover:border-[#06B6D4] hover:bg-slate-800 hover:text-white focus:ring-cyan-300`;

/* ═══ TYPE 4 · INTERACTIVE CARDS — solid elevated slate ═══════════════════ */

/**
 * Fully clickable cards (match cards, league cards, expandable slip rows).
 * Lifts physically on hover, gains depth shadow + a glowing top border.
 * `border-t-2 border-t-transparent` is set at rest so the glow adds no layout
 * shift when it appears.
 */
export const CARD_CLICK =
  `${IX} responsive-card block w-full rounded-lg border border-slate-700 border-t-2 border-t-transparent bg-slate-800 ` +
  "hover:-translate-y-2 hover:border-t-amber-400 hover:bg-slate-700 hover:shadow-2xl hover:shadow-amber-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60";

/** Same physical lift for live fixtures — glow burns rose instead of amber. */
export const CARD_CLICK_LIVE =
  `${IX} responsive-card block w-full rounded-lg border border-slate-700 border-t-2 border-t-transparent bg-slate-800 ` +
  "hover:-translate-y-2 hover:border-t-rose-400 hover:bg-slate-700 hover:shadow-2xl hover:shadow-rose-500/20 " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60";

/**
 * Card surfaces that contain buttons but aren't one big click target
 * (accumulator cards, saved-slip shells). Same elevated-slate language,
 * no global cursor-pointer, gentler lift.
 */
export const CARD_SURFACE =
  "responsive-card rounded-lg border border-slate-700 bg-slate-800 transition-all duration-200 " +
  "hover:-translate-y-1 hover:border-t-2 hover:border-t-amber-400/70 hover:shadow-2xl hover:shadow-amber-500/10";

/* ═══ TYPE 5 · FILTER CHIPS / LEAGUE PILLS — solid slate tags ═════════════ */

/**
 * Small scannable toggles. `border-l-4` is always present (transparent when
 * off) so activating a chip never shifts layout — the accent bar just ignites.
 */
export const CHIP =
  `${IX} chip-responsive inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full border-l-4 border-l-transparent ` +
  "active:scale-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Inactive chip: solid slate tag. */
export const CHIP_OFF = "bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white";

/** Active chip variants: solid colour + bold left accent bar. */
export const CHIP_ON_AMBER = "border-l-[#FF8C00] bg-[#F59E0B] font-bold text-white hover:bg-[#FF8C00]";
export const CHIP_ON_EMERALD = "border-l-emerald-400 bg-emerald-600 font-bold text-white hover:bg-emerald-500";
export const CHIP_ON_CYAN = "border-l-cyan-400 bg-cyan-600 font-bold text-white hover:bg-cyan-500";
export const CHIP_ON_ROSE = "border-l-rose-400 bg-rose-600 font-bold text-white hover:bg-rose-500";
export const CHIP_ON_VIOLET = CHIP_ON_AMBER;

/* ═══ TYPE 6 · MENU / DROPDOWN ITEMS — smooth slide-in links ═══════════════ */

/**
 * Flat list items inside menus & sidebars. Hover slides the row right and
 * ignites a bright left border. Left border exists at rest (transparent) to
 * avoid layout shift.
 */
export const MENU_ITEM =
  `${IX} block rounded-lg border-l-4 border-l-transparent text-slate-400 ` +
  "hover:translate-x-1 hover:border-l-amber-400 hover:bg-slate-800 hover:text-white active:scale-[0.98] " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60";

/** Currently-selected menu row keeps the accent lit. */
export const MENU_ITEM_ON = "border-l-amber-400 bg-slate-800 font-bold text-white";
