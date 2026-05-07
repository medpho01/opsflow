import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { getTokenFromRequest } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const token = getTokenFromRequest(request);
  if (token) {
    await prisma.session.deleteMany({ where: { token } }).catch(() => {});
  }
  const response = NextResponse.json({ success: true });
  response.cookies.delete("taskos_token");
  return response;
}
