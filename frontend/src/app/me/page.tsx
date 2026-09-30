import { Wallet } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function MePage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Recipient" title="Your payments" description="Only members with the recipient role reach this page." />
      <EmptyState icon={Wallet} title="Nothing received yet" description="Payments sent to you appear here once they land." />
    </div>
  );
}
