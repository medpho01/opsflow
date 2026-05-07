import { cookies } from "next/headers";
import { verifyToken } from "./jwt";
import { AuthUser } from "@/types";
import prisma from "@/lib/db/client";

const COOKIE_NAME = "taskos_token";

export async function getSession(): Promise<AuthUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          teamMember: { include: { storeAssignments: { select: { storeId: true } } } },
        },
      },
    },
  });

  if (!session || session.expiresAt < new Date()) return null;

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    teamMemberId: session.user.teamMember?.id,
    storeIds: session.user.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
  };
}

export function getTokenFromRequest(request: Request): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

export async function getSessionFromRequest(request: Request): Promise<AuthUser | null> {
  const token = getTokenFromRequest(request);
  if (!token) return null;

  const payload = await verifyToken(token);
  if (!payload) return null;

  const session = await prisma.session.findUnique({
    where: { token },
    include: {
      user: {
        include: {
          teamMember: { include: { storeAssignments: { select: { storeId: true } } } },
        },
      },
    },
  });

  if (!session || session.expiresAt < new Date()) return null;

  return {
    id: session.user.id,
    name: session.user.name,
    email: session.user.email,
    role: session.user.role,
    teamMemberId: session.user.teamMember?.id,
    storeIds: session.user.teamMember?.storeAssignments.map((a) => a.storeId) ?? [],
  };
}

export const COOKIE_NAME_EXPORT = COOKIE_NAME;
