import { base58FromBytes } from "../base58"

// Stand-ins for the Token-2022 accounts a run pays from and to, until the service says
// where the browser gets them (API_CONTRACT Q36). The same owner always gets the same
// account, and different owners different ones; nothing checks them on a chain.
export function mockTokenAccount(owner: string) {
  // FNV-1a over the whole owner, then stretched to 32 bytes.
  let state = 2166136261
  for (const byte of new TextEncoder().encode(`token-account:${owner}`)) {
    state = Math.imul(state ^ byte, 16777619) >>> 0
  }
  const bytes = Uint8Array.from({ length: 32 }, (_, i) => {
    state = Math.imul(state ^ i, 16777619) >>> 0
    return (state >>> 24) & 0xff
  })
  return base58FromBytes(bytes)
}

// A block every 400 ms, from the clock, so a page's fake clock moves it too. The service
// and the screens read the same height.
export const mockBlockHeight = (now = Date.now()) => Math.floor(now / 400)

// About a minute: how long a blockhash read now stays valid.
export const MOCK_BLOCKHASH_LIFETIME = 150
