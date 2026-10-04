import { readFileSync } from "node:fs"
import path from "node:path"
import bs58 from "bs58"

function decodeAddress(value) {
  if (typeof value !== "string") return null
  try {
    const bytes = bs58.decode(value)
    return bytes.length === 32 ? Buffer.from(bytes) : null
  } catch {
    return null
  }
}

// The earlier spike's synthetic confidential transfer (2,395 bytes, version byte 0x81),
// with its signer replaced by the wallet that will sign it.
export async function GET(request) {
  const to = decodeAddress(new URL(request.url).searchParams.get("address"))
  if (!to) return Response.json({ error: "bad_address" }, { status: 400 })
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "..", "..", "wallet-providers", "fixture.json"), "utf8"))
  const wire = Buffer.from(fixture.transaction, "base64")
  const from = Buffer.from(bs58.decode(fixture.address))
  for (let i = wire.indexOf(from); i !== -1; i = wire.indexOf(from, i + 32)) to.copy(wire, i)
  return Response.json({ hex: wire.toString("hex"), bytes: wire.length, version: wire[0] })
}
