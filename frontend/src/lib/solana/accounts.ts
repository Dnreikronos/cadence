import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Address,
} from "@solana/kit"
import { cluster, type ClusterName } from "./cluster"
import { programs } from "./programs"

// Circle's USDC on each cluster. This is the plain, public token; the confidential one
// is its token-wrap twin (`wrappedMint`).
export const usdcMints: Record<ClusterName, string> = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
}

const encode = (value: string) => getAddressEncoder().encode(address(value))
const text = (value: string) => new TextEncoder().encode(value)

type Seeds = Parameters<typeof getProgramDerivedAddress>[0]["seeds"]

const derive = async (program: string, seeds: Seeds) => {
  const [derived] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds,
  })
  return derived
}

// The account a wallet's tokens of `mint` live in: the associated account. A wrap
// debits exactly the USDC one (docs/dev/WRAP_API.md), so it is the balance that can be
// made private. Another USDC account the wallet happens to own is not.
export function associatedTokenAddress(
  owner: string,
  mint: string,
  tokenProgram: string = programs.token,
): Promise<Address> {
  return derive(programs.associatedToken, [
    encode(owner),
    encode(tokenProgram),
    encode(mint),
  ])
}

// The accounts of a wrap and an unwrap, derived as token-wrap derives them
// (`token_wrap.rs` `Addresses::derive`): there is one wrapped mint per deployment.
export type WrapAccounts = {
  usdcMint: string
  // The confidential token every account here and every payment holds.
  wrappedMint: string
  // Mints the wrapped token; owns the escrow.
  wrapAuthority: string
  // Holds the USDC behind every wrapped token.
  escrow: string
}

export async function wrapAccounts(
  usdcMint: string = usdcMints[cluster.name],
): Promise<WrapAccounts> {
  const wrappedMint = await derive(programs.tokenWrap, [
    text("mint"),
    encode(usdcMint),
    encode(programs.token2022),
  ])
  const wrapAuthority = await derive(programs.tokenWrap, [
    text("authority"),
    encode(wrappedMint),
  ])
  return {
    usdcMint,
    wrappedMint,
    wrapAuthority,
    escrow: await associatedTokenAddress(wrapAuthority, usdcMint),
  }
}

// A wallet's own two token accounts, as this app derives them: never as the service
// names them. The confidential one is where a wrap deposits, an unwrap withdraws from,
// and configure and apply pending act (`wrap.rs` / `unwrap.rs` `destination`, `source`).
export type WalletAccounts = WrapAccounts & {
  wallet: string
  // Its USDC associated account (SPL Token).
  usdc: string
  // Its wrapped-USDC associated account (Token-2022), with the confidential balance.
  confidential: string
}

export async function walletAccounts(
  wallet: string,
  usdcMint?: string,
): Promise<WalletAccounts> {
  const wrap = await wrapAccounts(usdcMint)
  return {
    ...wrap,
    wallet,
    usdc: await associatedTokenAddress(wallet, wrap.usdcMint),
    confidential: await associatedTokenAddress(
      wallet,
      wrap.wrappedMint,
      programs.token2022,
    ),
  }
}
