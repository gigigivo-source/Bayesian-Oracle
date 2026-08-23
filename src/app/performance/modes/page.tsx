import { redirect } from "next/navigation";

// /performance/modes is now the default /performance page. Keep this route
// so existing bookmarks and in-app links land on the multi-mode dashboard.
export default function RankingModePerformanceRedirect() {
  redirect("/performance");
}
