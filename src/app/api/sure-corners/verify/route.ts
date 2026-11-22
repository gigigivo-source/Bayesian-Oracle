// Route handlers live in ./core.ts so Next.js route files export only the
// fields allowed by the App Router type validator, and so the shared
// implementation can be imported by the /sure-corners server action.
import { requireCronAuth } from "@/lib/apiAuth";
import { runSureCornersVerify, SureCornersVerifyError } from "./core";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * POST /api/sure-corners/verify
 *
 * Auth: bearer header only, via `requireCronAuth` (@/lib/apiAuth) — constant
 * time compare, no `?key=` query secret, and FAIL CLOSED in production when
 * CRON_SECRET is unset.
 */
export async function POST(req: Request): Promise<Response> {
  const denied = requireCronAuth(req);
  if (denied) return denied;
  try {
    return Response.json(await runSureCornersVerify());
  } catch (error) {
    if (error instanceof SureCornersVerifyError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }
}

export const GET = (req: Request): Promise<Response> => POST(req);
