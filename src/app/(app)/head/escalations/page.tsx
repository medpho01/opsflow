import { getSession } from "@/lib/auth/session";
import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";
import EscalationChainsPanel from "@/components/head/EscalationChainsPanel";

export default async function EscalationsPage() {
  const user = await getSession();
  if (!user || user.role !== UserRole.OPS_HEAD) redirect("/");

  return <EscalationChainsPanel />;
}
