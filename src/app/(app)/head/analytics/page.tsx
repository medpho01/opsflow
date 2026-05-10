import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import AnalyticsTabs from "@/components/head/AnalyticsTabs";

export const metadata = { title: "Analytics — OpsFlow" };

export default async function AnalyticsPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return (
    <div className="p-6 max-w-6xl">
      <AnalyticsTabs />
    </div>
  );
}
