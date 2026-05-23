import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db/client";
import { verifyPassword } from "@/lib/auth/password";
import { signToken } from "@/lib/auth/jwt";
import { JwtPayload } from "@/types";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();

    if (!email || !password) {
      return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { teamMember: true },
    });

    if (!user || !user.isActive) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const valid = await verifyPassword(password, user.passwordHash);
    if (!valid) {
      return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
    }

    const payload: JwtPayload = {
      userId: user.id,
      email: user.email,
      role: user.role,
      name: user.name,
    };

    const token = await signToken(payload);

    // Store session in DB (8 hours)
    const expiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000);
    await prisma.session.create({
      data: { userId: user.id, token, expiresAt },
    });

    // Determine post-login landing page based on role.
    // Agents land on Smart View (the new bucketed task surface) rather
    // than the legacy /agent list — Smart View is the primary workflow
    // and matches how Leads experience the product. The legacy /agent
    // page is still reachable from the sidebar's "All Tasks" entry.
    const redirectPath =
      user.role === "OPS_HEAD" ? "/head" :
      user.role === "STORE_ADMIN" ? "/store" : "/agent/smart-view";

    const response = NextResponse.json({
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
      redirectPath,
    });

    response.cookies.set("taskos_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 8 * 60 * 60,
      path: "/",
    });

    return response;
  } catch (error) {
    console.error("[LOGIN]", error);
    return NextResponse.json({ error: "Internal server error" }, { status: 500 });
  }
}
