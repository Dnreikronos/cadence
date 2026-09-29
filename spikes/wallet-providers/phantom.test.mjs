import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { inspectPhantom } from "./phantom-capabilities.mjs";
import { createPhantomServer } from "./phantom-server.mjs";

const wallet = (versions) => ({
	name: "Phantom",
	features: {
		"solana:signTransaction": { supportedTransactionVersions: versions },
	},
});

test("legacy/v0 support must not pass the v1 gate", () => {
	assert.equal(inspectPhantom([wallet(["legacy", 0])]).status, "unsupported");
	assert.equal(inspectPhantom([wallet(["1"])]).status, "unsupported");
});

test("missing capability is inconclusive and another wallet cannot stand in for Phantom", () => {
	assert.equal(inspectPhantom([]).status, "not-found");
	assert.equal(
		inspectPhantom([{ name: "Phantom", features: {} }]).status,
		"unknown",
	);
	assert.equal(
		inspectPhantom([{ ...wallet([1]), name: "Other" }]).status,
		"not-found",
	);
});

test("v1 advertisement is distinguished from proof of a successful transfer", () => {
	const result = inspectPhantom([wallet(["legacy", 0, 1])]);
	assert.equal(result.status, "advertised");
	assert.match(result.message, /must still be signed and confirmed/);
});

test("local server serves only the capability page and its modules", async (t) => {
	const server = createPhantomServer().listen(0, "127.0.0.1");
	t.after(() => server.close());
	await once(server, "listening");
	const origin = `http://127.0.0.1:${server.address().port}`;
	for (const route of [
		"/",
		"/phantom-capabilities.mjs",
		"/node_modules/@wallet-standard/app/lib/esm/wallets.js",
	]) {
		const response = await fetch(origin + route);
		assert.equal(response.status, 200);
		assert.match(
			response.headers.get("content-security-policy"),
			/default-src 'none'/,
		);
		await response.text();
	}
	assert.equal((await fetch(`${origin}/.env`)).status, 404);
	assert.equal((await fetch(`${origin}/sign.mjs`)).status, 404);
	assert.equal((await fetch(origin, { method: "POST" })).status, 404);
});
