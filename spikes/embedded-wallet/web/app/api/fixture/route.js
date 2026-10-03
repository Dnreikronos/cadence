import { readFileSync } from "node:fs"
import path from "node:path"
import bs58 from "bs58"

// The earlier spike's synthetic confidential transfer (2,395 bytes, version byte 0x81),
// with its signer replaced by the wallet that will sign it.
export async function GET(request) {
  const address = new URL(request.url).searchParams.get("address")
  const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "..", "..", "wallet-providers", "fixture.json"), "utf8"))
  const wire = Buffer.from(fixture.transaction, "base64")
  const from = Buffer.from(bs58.decode(fixture.address)), to = Buffer.from(bs58.decode(address))
  for (let i = wire.indexOf(from); i !== -1; i = wire.indexOf(from, i + 32)) to.copy(wire, i)
  return Response.json({ hex: wire.toString("hex"), bytes: wire.length, version: wire[0] })
}
