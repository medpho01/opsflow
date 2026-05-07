import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import ArchivedTasksBoard from "@/components/head/ArchivedTasksBoard";

export const metadata = { title: "Archived Tasks — OpsFlow" };

export default async function ArchivedTasksPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return <ArchivedTasksBoard />;
}
