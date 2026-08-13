import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { WhatsAppSettings } from "@/components/head/WhatsAppSettings";

export const metadata = { title: "WhatsApp settings | TaskOS" };

export default async function WhatsAppSettingsPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== UserRole.OPS_HEAD) redirect("/agent");
  return (
    <div className="p-6 max-w-7xl mx-auto">
      <WhatsAppSettings />
    </div>
  );
}
