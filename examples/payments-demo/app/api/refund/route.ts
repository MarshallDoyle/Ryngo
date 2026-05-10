import { NextResponse } from "next/server";
import { z } from "zod";
import { postRefund } from "@/lib/api-client";

const RefundRequest = z.object({
  chargeId: z.string().min(1),
  reason: z.string().min(1),
});

export async function POST(req: Request) {
  const body = await req.json();
  const parsed = RefundRequest.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await postRefund(parsed.data);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
