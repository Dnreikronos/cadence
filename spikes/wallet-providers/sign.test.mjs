import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PrivyClient } from "@privy-io/node";
import { VersionedTransaction } from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { signPrivy, signTurnkeyApi, signTurnkeySdk } from "./sign.mjs";

const fixture = JSON.parse(
	readFileSync(new URL("./fixture.json", import.meta.url), "utf8"),
);
const wire = Buffer.from(fixture.transaction, "base64");

test("Rust fixture contains v1 confidential transfer and three proof instructions", () => {
	assert.equal(wire[0], 0x81);
	assert.equal(wire.length, 2395);
	const transaction = VersionedTransaction.deserialize(wire);
	assert.equal(transaction.version, 1);
	assert.equal(transaction.message.compiledInstructions.length, 4);
	assert.deepEqual(
		[...transaction.message.compiledInstructions[0].data.subarray(0, 2)],
		[27, 7],
	);
});

test("Turnkey Solana SDK fails locally before calling the provider for this v1 transfer", async (t) => {
	const client = new Turnkey({
		apiBaseUrl: "https://api.turnkey.com",
		defaultOrganizationId: "offline",
		apiPublicKey: "offline",
		apiPrivateKey: "offline",
	}).apiClient();
	const request = t.mock.method(client, "signTransaction", async () => {
		throw new Error("Unexpected provider call");
	});
	await assert.rejects(
		signTurnkeySdk(client, wire, fixture.address, "offline"),
		/Serialization of version 1 transaction messages is not supported/,
	);
	assert.equal(request.mock.callCount(), 0);
});

test("Turnkey transaction API adapter preserves Rust bytes without web3 serialization", async (t) => {
	const client = new Turnkey({
		apiBaseUrl: "https://api.turnkey.com",
		defaultOrganizationId: "offline",
		apiPublicKey: "offline",
		apiPrivateKey: "offline",
	}).apiClient();
	const request = t.mock.method(client, "signTransaction", async (input) => {
		assert.equal(input.signWith, fixture.address);
		assert.equal(input.unsignedTransaction, wire.toString("hex"));
		assert.equal(input.type, "TRANSACTION_TYPE_SOLANA");
		return {
			activity: { status: "ACTIVITY_STATUS_COMPLETED" },
			signedTransaction: wire.toString("hex"),
		};
	});
	assert.deepEqual(await signTurnkeyApi(client, wire, fixture.address), wire);
	assert.equal(request.mock.callCount(), 1);
	// The echo response is deliberately unsigned: this proves transport, not signing.
});

test("Privy's real SDK passes the full v1 wire unchanged to its HTTP transport", async () => {
	let calls = 0;
	const client = new PrivyClient({
		appId: "offline",
		appSecret: "offline",
		maxRetries: 0,
		fetch: async (_url, options) => {
			calls++;
			const body = JSON.parse(options.body);
			assert.equal(body.method, "signTransaction");
			assert.equal(body.params.encoding, "base64");
			assert.equal(body.params.transaction, wire.toString("base64"));
			return new Response(
				JSON.stringify({
					method: "signTransaction",
					data: {
						signed_transaction: wire.toString("base64"),
						encoding: "base64",
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		},
	});
	assert.deepEqual(await signPrivy(client, wire, "offline-wallet", {}), wire);
	assert.equal(calls, 1);
});
