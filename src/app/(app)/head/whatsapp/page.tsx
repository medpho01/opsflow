import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { WhatsAppControlTower } from "@/components/head/WhatsAppControlTower";

export const metadata = { title: "WhatsApp | TaskOS" };

export default async function WhatsAppPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role !== UserRole.OPS_HEAD) redirect("/agent");
  return (
    <div className="h-full">
      <WhatsAppControlTower />
    </div>
  );
}
