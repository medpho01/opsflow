import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import RosterPanel from "@/components/head/RosterPanel";

export const metadata = { title: "Daily Roster — OpsFlow" };

export default async function RosterPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <RosterPanel />;
}
