import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import HeadCommandCenter from "@/components/head/HeadCommandCenter";

export const metadata = { title: "Command Center — OpsFlow" };

export default async function HeadPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <HeadCommandCenter />;
}
