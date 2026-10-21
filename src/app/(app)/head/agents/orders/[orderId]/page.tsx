import { AgentJourneyTimeline } from "@/components/head/AgentJourneyTimeline";

export const metadata = { title: "Order timeline | OpsFlow Agents" };

export default async function AgentOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  return <AgentJourneyTimeline orderId={Number(orderId)} />;
}
