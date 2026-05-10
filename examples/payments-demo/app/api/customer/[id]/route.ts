import { NextResponse } from "next/server";
import { getCustomer } from "@/lib/api-client";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const result = await getCustomer(id);
  if (!result.ok) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(result);
}
