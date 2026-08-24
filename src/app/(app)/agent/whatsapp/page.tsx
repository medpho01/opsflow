import { getSession } from "@/lib/auth/session";
import { UserRole } from "@prisma/client";
import { redirect } from "next/navigation";
import { WhatsAppControlTower } from "@/components/head/WhatsAppControlTower";

export const metadata = { title: "WhatsApp | TaskOS" };

// Ops agents work the same shared loop queue as the Lead — same Control Tower,
// minus the admin controls (Settings / group config live under /head).
export default async function AgentWhatsAppPage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === UserRole.OPS_HEAD) redirect("/head/whatsapp");
  if (user.role !== UserRole.OPS_AGENT) redirect("/");
  return (
    <div className="h-full">
      <WhatsAppControlTower canAdmin={false} />
    </div>
  );
}
