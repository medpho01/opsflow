import { NonApiLabConfigPanel } from "@/components/head/NonApiLabConfigPanel";

export const metadata = { title: "Lab Config | OpsFlow" };

// Configuration only. Delivery deadlines live in each lab's Edit dialog; order
// activity belongs on the board, not here.
export default function LabConfigPage() {
  return <NonApiLabConfigPanel />;
}
