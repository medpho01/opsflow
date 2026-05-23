import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import MyWorkBoard from "@/components/head/MyWorkBoard";

export const metadata = { title: "Smart View — OpsFlow" };

/**
 * Smart View for agents — same component as /head/my-work.
 *
 * The component is role-aware (currentUser.role gates filter bar +
 * reassign UI). The /api/tasks endpoint role-scopes results, so an
 * agent here only sees their own tasks.
 *
 * The legacy /agent route (AgentTaskBoard) stays alive as a fallback
 * during the transition. Once Smart View is validated with the team
 * we can redirect /agent → /agent/smart-view.
 */
export default async function AgentSmartViewPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "OPS_HEAD") redirect("/head/my-work");
  if (user.role === "STORE_ADMIN") redirect("/store");

  return <MyWorkBoard currentUser={{ id: user.id, name: user.name, role: user.role }} />;
}
