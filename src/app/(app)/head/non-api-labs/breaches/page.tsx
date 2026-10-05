import { redirect } from "next/navigation";

// Deadline watchers became message rules (Oct 2026); kept so old links still land.
export default function BreachesPage() {
  redirect("/head/non-api-labs/message-rules");
}
