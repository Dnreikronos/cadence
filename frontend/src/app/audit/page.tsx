import { Send } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function AuditPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Auditor" title="Payments" description="Only members with the auditor role reach this page." />
      <EmptyState icon={Send} title="No payments to review" description="Payments from the company you audit appear here." />
    </div>
  );
}
