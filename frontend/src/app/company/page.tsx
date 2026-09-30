import { Send } from "lucide-react";
import { PageHeader } from "@/components/app/page-header";
import { EmptyState } from "@/components/ui/empty-state";

export default function CompanyPage() {
  return (
    <div className="space-y-6">
      <PageHeader eyebrow="Company" title="Payments" description="Only members with the admin role reach this page." />
      <EmptyState icon={Send} title="No payments yet" description="Deposit USDC, then pay your first recipient." />
    </div>
  );
}
