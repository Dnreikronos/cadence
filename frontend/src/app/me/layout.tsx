import { AppShell } from "@/components/app/app-shell";
import { pendingBalance, pendingCompany } from "@/components/app/pending-membership";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell role="recipient" company={pendingCompany} balance={pendingBalance}>
      {children}
    </AppShell>
  );
}
