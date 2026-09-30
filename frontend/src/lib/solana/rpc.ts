import type { RpcTransport } from "@solana/kit";
import { createDefaultRpcTransport, createSolanaRpcFromTransport } from "@solana/kit";
import { cluster } from "./cluster";

// A confidential transfer only fits in a v1 transaction (up to 4,096 bytes).
// Nodes refuse to return one unless asked, so every read that can return a
// transaction asks — whatever the caller passed.
const TRANSACTION_VERSION = 1;
const returnsTransactions = new Set(["getBlock", "getTransaction", "getTransactionsForAddress"]);

type Payload = { method: string; params: unknown[] };

function pin(raw: unknown): unknown {
  const payload = raw as Partial<Payload>;
  if (!payload.method || !returnsTransactions.has(payload.method) || !Array.isArray(payload.params)) return raw;
  const [target, config] = payload.params;
  const options = typeof config === "object" && config !== null ? config : {};
  return {
    ...payload,
    params: [target, { ...options, maxSupportedTransactionVersion: TRANSACTION_VERSION }],
  };
}

export function pinTransactionVersion(transport: RpcTransport): RpcTransport {
  return (config) => transport({ ...config, payload: pin(config.payload) });
}

export function createRpc(url: string = cluster.rpcUrl) {
  return createSolanaRpcFromTransport(pinTransactionVersion(createDefaultRpcTransport({ url })));
}
