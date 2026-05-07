import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/session";

export default async function RootPage() {
  const user = await getSession();

  if (!user) redirect("/login");

  switch (user.role) {
    case "OPS_HEAD": redirect("/head");
    case "STORE_ADMIN": redirect("/store");
    default: redirect("/agent");
  }
}
