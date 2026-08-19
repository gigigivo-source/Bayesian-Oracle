import { db } from "@/db";
import { userSettings } from "@/db/schema";
import { hashPin, verifyPin } from "@/lib/hash";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db.select().from(userSettings).limit(1);
    const row = rows[0];
    return Response.json({ hasPin: !!row, name: row?.displayName ?? null });
  } catch {
    return Response.json({ hasPin: false, name: null });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { action?: string; pin?: string; name?: string };
    const action = body.action as string;
    const pin = String(body.pin ?? "");

    if (action === "setup") {
      if (pin.length < 4) return Response.json({ error: "PIN too short" }, { status: 400 });
      const existing = await db.select().from(userSettings).limit(1);
      if (existing[0]) {
        await db
          .update(userSettings)
          .set({ pin: hashPin(pin), displayName: body.name ?? "User" })
          .where(eq(userSettings.id, existing[0].id));
      } else {
        await db.insert(userSettings).values({
          pin: hashPin(pin),
          displayName: body.name ?? "User",
        });
      }
      return Response.json({ ok: true });
    }

    if (action === "verify") {
      const rows = await db.select().from(userSettings).limit(1);
      const row = rows[0];
      if (!row) return Response.json({ valid: true }); // no PIN set = open access
      return Response.json({ valid: verifyPin(pin, row.pin) });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch {
    return Response.json({ error: "server error" }, { status: 500 });
  }
}
