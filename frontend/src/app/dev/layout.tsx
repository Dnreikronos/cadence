import { notFound } from "next/navigation";
import { cluster } from "@/lib/solana/cluster";

// Dev tooling renders fake data; it never ships to mainnet.
export default function DevLayout({ children }: { children: React.ReactNode }) {
  if (cluster.isMainnet) notFound();
  return children;
}
