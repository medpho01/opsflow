import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";
import StoreBoard from "@/components/store/StoreBoard";

export const metadata = { title: "Store Overview — OpsFlow" };

export default async function StorePage() {
  const user = await getSession();
  if (!user) redirect("/login");
  if (user.role === "OPS_AGENT") redirect("/agent");

  return <StoreBoard user={user} />;
}
