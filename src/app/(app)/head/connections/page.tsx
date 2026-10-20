import { redirect } from "next/navigation";
import { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth/session";
import { ConnectionsPage } from "@/components/head/connections/ConnectionsPage";

export const metadata = { title: "Connections | OpsFlow" };

export default async function Connections({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== UserRole.OPS_HEAD) redirect("/agent");
  const tab = (await searchParams).tab;
  return <ConnectionsPage initialTab={tab === "stores" || tab === "groups" ? tab : "labs"} />;
}
