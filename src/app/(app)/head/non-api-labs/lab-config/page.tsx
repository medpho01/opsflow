import { redirect } from "next/navigation";

// Lab Config is the Labs tab of Connections now (labs, stores and their groups in one place).
export default function LabConfigPage() {
  redirect("/head/connections?tab=labs");
}
