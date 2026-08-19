import { db } from "@/db";
import { bankroll } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const rows = await db
      .select()
      .from(bankroll)
      .orderBy(desc(bankroll.createdAt))
      .limit(100);

    const balance      = rows[0]?.balance ?? 0;
    const deposits     = rows.filter((r) => r.type === "deposit").reduce((s, r) => s + r.amount, 0);
    const totalStaked  = rows.filter((r) => r.type === "bet").reduce((s, r) => s + Math.abs(r.amount), 0);
    const totalReturns = rows.filter((r) => r.type === "win").reduce((s, r) => s + r.amount, 0);
    const totalBets    = rows.filter((r) => r.type === "bet").length;
    const wonBets      = rows.filter((r) => r.type === "win").length;
    const profitLoss   = totalReturns - totalStaked;
    const roi          = totalStaked > 0 ? (profitLoss / totalStaked) * 100 : 0;

    return Response.json({
      balance,
      deposits,
      totalStaked,
      totalReturns,
      roi,
      profitLoss,
      totalBets,
      wonBets,
      entries: rows.map((r) => ({
        id:          r.id,
        type:        r.type,
        amount:      r.amount,
        balance:     r.balance,
        description: r.description,
        createdAt:   r.createdAt.toISOString(),
      })),
    });
  } catch {
    return Response.json({
      balance: 0, deposits: 0, totalStaked: 0, totalReturns: 0,
      roi: 0, profitLoss: 0, totalBets: 0, wonBets: 0, entries: [],
    });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json() as { type?: string; amount?: number | string; description?: string };
    const { type, amount, description } = body;
    const amt = Number(amount);
    if (isNaN(amt)) return Response.json({ error: "invalid amount" }, { status: 400 });

    const rows = await db
      .select()
      .from(bankroll)
      .orderBy(desc(bankroll.createdAt))
      .limit(1);

    const prevBalance = rows[0]?.balance ?? 0;
    const newBalance  = prevBalance + amt;

    await db.insert(bankroll).values({
      type:        String(type ?? "deposit"),
      amount:      amt,
      balance:     newBalance,
      description: String(description ?? ""),
    });

    return Response.json({ ok: true, balance: newBalance });
  } catch {
    return Response.json({ error: "server error" }, { status: 500 });
  }
}
