import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";

export const metadata = { title: "Agents | OpsFlow" };

/** Role guard and page frame for the OpsFlow Agents screens (DESIGN.md §7). */
export default async function AgentsLayout({ children }: { children: React.ReactNode }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== UserRole.OPS_HEAD && user.role !== UserRole.OPS_AGENT) redirect("/agent");
  return <div className="p-6 max-w-7xl mx-auto">{children}</div>;
}
