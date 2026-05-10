import { NextResponse, type NextRequest } from "next/server";

// Auth middleware applied to /api/refund/* and /api/customer/* but NOT /api/charge/*.
// codegraph should render this as a typed edge from the matched route nodes
// to the auth middleware function, with the unmatched routes lacking that edge.
export const config = {
  matcher: ["/api/refund/:path*", "/api/customer/:path*"],
};

export function middleware(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.next();
}
