import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import AllTasksBoard from "@/components/head/AllTasksBoard";

export const metadata = { title: "All Tasks — OpsFlow" };

export default async function AllTasksPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <AllTasksBoard />;
}
