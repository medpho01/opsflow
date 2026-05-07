import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export const metadata = { title: "Task Rules — OpsFlow" };

export default async function RulesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== "OPS_HEAD") redirect("/agent");

  return children;
}
