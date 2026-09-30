import { AppShell } from "@/components/app/app-shell";
import { pendingCompany } from "@/components/app/pending-membership";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell role="auditor" company={pendingCompany}>
      {children}
    </AppShell>
  );
}
