import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import EngineHealth from "@/components/head/EngineHealth";

export const metadata = { title: "Engine Health — OpsFlow" };

export default async function EnginePage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return (
    <div className="p-6 max-w-5xl">
      <EngineHealth />
    </div>
  );
}
