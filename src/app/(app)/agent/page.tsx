import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import AgentTaskBoard from "@/components/agent/AgentTaskBoard";

export const metadata = { title: "My Tasks — OpsFlow" };

export default async function AgentPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "OPS_HEAD") redirect("/head");
  if (user.role === "STORE_ADMIN") redirect("/store");

  return <AgentTaskBoard userId={user.id} userName={user.name} />;
}
