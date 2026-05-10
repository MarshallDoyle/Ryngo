import { NextResponse } from "next/server";
import { z } from "zod";
import { postCharge } from "@/lib/api-client";

const ChargeRequest = z.object({
  amount: z.number().int().positive(),
  currency: z.string().length(3),
  customerId: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = ChargeRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await postCharge(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
