import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import AgentPerformancePanel from "@/components/head/AgentPerformancePanel";
import DailySummaryPanel from "@/components/head/DailySummaryPanel";

export const metadata = { title: "Analytics — OpsFlow" };

export default async function AnalyticsPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return (
    <div className="p-6 space-y-10 max-w-6xl">
      <AgentPerformancePanel />
      <div className="border-t border-zinc-800" />
      <DailySummaryPanel />
    </div>
  );
}
