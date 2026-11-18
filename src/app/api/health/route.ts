import { apiError, errorMessage } from "@/lib/apiErrors";
import { db } from "@/db";
import { sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ ok: true });
  } catch (__caughtError) {
    return Response.json({
      error: "Internal Server Error",
      details: errorMessage(__caughtError), ok: false }, { status: 500 });
  }

  } catch (__routeError) {
    return apiError("GET /api/health failed", __routeError);
  }
}
