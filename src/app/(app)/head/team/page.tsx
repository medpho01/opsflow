import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import TeamPanel from "@/components/head/TeamPanel";

export const metadata = { title: "Team — OpsFlow" };

export default async function TeamPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <TeamPanel />;
}
