import { TemplateLibrary } from "@/components/head/TemplateLibrary";
import { PollDefinitionsPanel } from "@/components/head/PollDefinitionsPanel";

export const metadata = { title: "Message Templates | OpsFlow" };

export default function ProviderTemplatesPage() {
  return (
    <>
      <TemplateLibrary />
      {/* How labs answer a poll a rule sends, and what they hear back. */}
      <div className="mt-8"><PollDefinitionsPanel /></div>
    </>
  );
}
