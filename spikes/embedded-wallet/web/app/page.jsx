"use client"

import { useRef, useState } from "react"
import { useTurnkey } from "@turnkey/react-wallet-kit"
import { createClient } from "@supabase/supabase-js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

const email = "spike+browser@cadence.test"

// One client for the page, made on first use. Making it inside the component would build
// a new GoTrue client on every render ("Multiple GoTrueClient instances").
let supabaseClient
function supabase() {
  supabaseClient ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  return supabaseClient
}

export default function Page() {
  const turnkey = useTurnkey()
  const address = useRef(null)
  const [log, setLog] = useState([])
  const write = (line) => setLog((l) => [...l, typeof line === "string" ? line : JSON.stringify(line)])

  async function run(name, fn) {
    write(`> ${name}`)
    try { await fn() } catch (e) { write(`  FAILED: ${e?.message ?? e}`) }
  }

  const probe = () =>
    run("what the hook exposes", async () => {
      write({ clientState: String(turnkey.clientState), authState: String(turnkey.authState) })
      write(Object.keys(turnkey).filter((k) => typeof turnkey[k] === "function").sort().join(", "))
    })

  const supabaseSignIn = () =>
    run("Supabase sign-in (dev link instead of an email code)", async () => {
      const r = await fetch("/api/dev-session", { method: "POST", body: JSON.stringify({ email }) }).then((x) => x.json())
      if (r.error) throw new Error(r.error)
      const { data, error } = await supabase().auth.verifyOtp({ token_hash: r.token_hash, type: r.type })
      if (error) throw error
      write({ signedIn: !!data.session })
    })

  const turnkeyLogin = () =>
    run("Turnkey login with the Supabase session", async () => {
      // 1. The browser makes its own key pair; the private half stays in IndexedDB.
      const publicKey = await turnkey.createApiKeyPair()
      write({ publicKeyLength: publicKey.length })
      // 2. Bind the next access token to that key through user metadata and the hook.
      const tknonce = bytesToHex(sha256(utf8ToBytes(publicKey)))
      await supabase().auth.updateUser({ data: { tknonce } })
      const { data } = await supabase().auth.refreshSession()
      // 3. Our route holds the parent key and exchanges the token for a session.
      const res = await fetch("/api/turnkey-login", {
        method: "POST",
        body: JSON.stringify({ oidcToken: data.session.access_token, publicKey }),
      }).then((x) => x.json())
      if (res.error) throw new Error(res.error)
      write({ sessionReceived: !!res.session, subOrganizationCreated: res.created })
      // 4. Keep the session where the SDK looks for it.
      await turnkey.storeSession({ sessionToken: res.session })
      const session = await turnkey.getSession()
      write({ stored: !!session, expiresInSeconds: session ? Math.round(session.expiry - Date.now() / 1000) : null })
    })

  const loadWallet = () =>
    run("load the wallet", async () => {
      const wallets = await turnkey.fetchWallets()
      const account = wallets?.[0]?.accounts?.[0]
      address.current = account
      write({ wallets: wallets?.length, firstAccountAddressLength: account?.address?.length, addressFormat: account?.addressFormat })
    })

  const signV1 = (times = 1) => () =>
    run(`sign the v1 transaction ${times} time(s)`, async () => {
      if (!address.current) throw new Error("load the wallet first")
      const fx = await fetch(`/api/fixture?address=${address.current.address}`).then((x) => x.json())
      write({ transactionBytes: fx.bytes, versionByte: fx.version })
      const started = performance.now()
      let failed = 0
      for (let i = 0; i < times; i++) {
        try {
          await turnkey.signTransaction({ walletAccount: address.current, unsignedTransaction: fx.hex, transactionType: "TRANSACTION_TYPE_SOLANA" })
        } catch (e) { failed++; if (failed === 1) write(`  first failure at ${i}: ${e?.message}`) }
      }
      write({ signed: times - failed, failed, totalMs: Math.round(performance.now() - started) })
    })

  const signMsg = () =>
    run("sign a message", async () => {
      if (!address.current) throw new Error("load the wallet first")
      const r = await turnkey.signMessage({ walletAccount: address.current, message: "Cadence key derivation spike message" })
      write({ signed: !!r, keys: Object.keys(r ?? {}) })
    })

  const renew = () =>
    run("renew the session", async () => {
      const r = await turnkey.refreshSession({ expirationSeconds: "3600" })
      const session = await turnkey.getSession()
      write({ refreshed: !!r, expiresInSeconds: session ? Math.round(session.expiry - Date.now() / 1000) : null })
    })

  return (
    <main>
      <h1>Embedded wallet spike (#77)</h1>
      <p>Run in order. State: {String(turnkey.clientState)}</p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button onClick={probe}>0 hook</button>
        <button onClick={supabaseSignIn}>1 Supabase sign-in</button>
        <button onClick={turnkeyLogin}>2 Turnkey login</button>
        <button onClick={loadWallet}>3 load wallet</button>
        <button onClick={signV1(1)}>4 sign v1</button>
        <button onClick={signV1(20)}>5 sign v1 x20</button>
        <button onClick={signMsg}>6 sign message</button>
        <button onClick={renew}>7 renew</button>
        <button onClick={() => setLog([])}>clear</button>
      </p>
      <pre id="log" style={{ background: "#f4f4f2", padding: 12, whiteSpace: "pre-wrap" }}>{log.join("\n") || "nothing yet"}</pre>
    </main>
  )
}
