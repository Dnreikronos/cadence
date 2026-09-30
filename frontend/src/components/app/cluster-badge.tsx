import { cluster } from "@/lib/solana/cluster";

// Anything not on mainnet moves test money; say so on every page.
export function ClusterBadge() {
  if (cluster.isMainnet) return null;
  return (
    <div className="fixed right-3 bottom-3 z-50 rounded-md bg-amber-400 px-2 py-1 font-mono text-xs font-semibold tracking-wider text-amber-950 uppercase shadow">
      {cluster.name}
    </div>
  );
}
