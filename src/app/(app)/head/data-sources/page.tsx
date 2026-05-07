/**
 * Data Sources Management Page
 * /head/data-sources
 *
 * Allows OPS_HEAD to configure and manage task sources
 */

import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { DataSourcesManager } from "@/components/head/DataSourcesManager";

export default async function DataSourcesPage() {
  const user = await getSession();

  if (!user || user.role !== UserRole.OPS_HEAD) {
    redirect("/");
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <DataSourcesManager />
    </div>
  );
}

export const metadata = {
  title: "Data Sources | TaskOS",
  description: "Manage multi-source task creation configuration",
};
