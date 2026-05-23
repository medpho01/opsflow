import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import MyWorkBoard from "@/components/head/MyWorkBoard";

export const metadata = { title: "My Work — OpsFlow" };

/**
 * Phase-1 My Work view.
 *
 * Lives alongside /head/tasks (AllTasksBoard) instead of replacing it,
 * so we can A/B without disruption. Once validated, the old tasks page
 * can redirect here or be removed.
 *
 * Tabs:
 *   Today    — sliding NOW window + LATER TODAY + DONE TODAY
 *   Tomorrow — early-morning prep callout + day summary
 *   Stuck    — flat filterable list (age + type chips)
 */
export default async function MyWorkPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <MyWorkBoard />;
}
