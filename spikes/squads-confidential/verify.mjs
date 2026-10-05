import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import bs58 from "bs58";

export async function verify(evidence) {
	const url = evidence.verification_rpc;
	async function rpc(method, params) {
		for (let attempt = 0; attempt < 6; attempt++) {
			const response = await fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			});
			if ((response.status === 429 || response.status >= 500) && attempt < 5) {
				await delay(10_000 * (attempt + 1));
				continue;
			}
			assert.ok(response.ok, `RPC HTTP ${response.status}`);
			const body = await response.json();
			if (body.error?.code === -32029 && attempt < 5) {
				await delay(10_000 * (attempt + 1));
				continue;
			}
			assert.equal(body.error, undefined, JSON.stringify(body.error));
			assert.ok(body.result, `${method} returned no result`);
			return body.result;
		}
		throw new Error(`${method} exhausted retries`);
	}
	assert.equal(
		await rpc("getGenesisHash", []),
		"EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
	);
	const payment = evidence.events.find(
		(event) => event.step === "confidential vault transfer",
	);
	assert.ok(payment?.signature, "Evidence has no confirmed payment");
	const signature = payment.signature;
	const parsed = await rpc("getTransaction", [
		signature,
		{
			encoding: "jsonParsed",
			commitment: "confirmed",
			maxSupportedTransactionVersion: 1,
		},
	]);
	assert.equal(parsed.version, 1);
	assert.equal(parsed.meta.err, null);
	const outer = parsed.transaction.message.instructions;
	assert.equal(outer.length, 4);
	assert.equal(outer[0].programId, evidence.squads_program);
	assert.ok(
		outer
			.slice(1)
			.every(
				(ix) => ix.programId === "ZkE1Gama1Proof11111111111111111111111111111",
			),
	);
	const inner = parsed.meta.innerInstructions.flatMap(
		(group) => group.instructions,
	);
	const transfer = inner.find(
		(ix) => ix.parsed?.type === "confidentialTransfer",
	);
	assert.ok(transfer, "No confidential transfer inside Squads execute");
	assert.equal(transfer.stackHeight, 2);
	assert.equal(transfer.parsed.info.owner, evidence.vault);
	assert.equal(transfer.parsed.info.source, evidence.sender);
	assert.equal(transfer.parsed.info.destination, evidence.recipient);
	assert.equal(transfer.parsed.info.amount, undefined);
	const raw = await rpc("getTransaction", [
		signature,
		{
			encoding: "json",
			commitment: "confirmed",
			maxSupportedTransactionVersion: 1,
		},
	]);
	const keys = raw.transaction.message.accountKeys;
	const rawTransfer = raw.meta.innerInstructions
		.flatMap((group) => group.instructions)
		.find((ix) => keys[ix.programIdIndex] === transfer.programId);
	assert.ok(rawTransfer, "No raw Token-2022 CPI");
	const bytes = Buffer.from(bs58.decode(rawTransfer.data));
	assert.equal(bytes.length, 169);
	const units = Buffer.alloc(8);
	units.writeBigUInt64LE(420_000n);
	assert.equal(bytes.includes(units), false);
	return {
		signature,
		slot: parsed.slot,
		version: parsed.version,
		wire_bytes: payment.wire_bytes,
		outer_programs: outer.map((ix) => ix.programId),
		confidential_transfer: transfer,
		raw_transfer_bytes: bytes.length,
		plaintext_amount_field: false,
		plaintext_amount_bytes: false,
	};
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const evidence = JSON.parse(readFileSync(process.argv[2], "utf8"));
	process.stdout.write(`${JSON.stringify(await verify(evidence), null, 2)}\n`);
}
