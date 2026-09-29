import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PrivyClient } from "@privy-io/node";
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { Turnkey } from "@turnkey/sdk-server";
import { TurnkeySigner } from "@turnkey/solana";

export function required(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing ${name}`);
	return value;
}

export function checkConfiguration() {
	const mode = required("WALLET_PROVIDER");
	new PublicKey(required("WALLET_ADDRESS"));
	if (mode === "turnkey-sdk" || mode === "turnkey-api") {
		for (const name of [
			"TURNKEY_ORGANIZATION_ID",
			"TURNKEY_API_PUBLIC_KEY",
			"TURNKEY_API_PRIVATE_KEY",
		])
			required(name);
	} else if (mode === "privy") {
		for (const name of ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_WALLET_ID"])
			required(name);
		if (
			!process.env.PRIVY_USER_JWT &&
			!process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
		) {
			throw new Error(
				"Provide PRIVY_USER_JWT or PRIVY_AUTHORIZATION_PRIVATE_KEY for the wallet owner",
			);
		}
	} else throw new Error("Unknown WALLET_PROVIDER");
	return mode;
}

export function turnkeyClient() {
	return new Turnkey({
		apiBaseUrl: "https://api.turnkey.com",
		defaultOrganizationId: required("TURNKEY_ORGANIZATION_ID"),
		apiPublicKey: required("TURNKEY_API_PUBLIC_KEY"),
		apiPrivateKey: required("TURNKEY_API_PRIVATE_KEY"),
	}).apiClient();
}

/** @param {import('@turnkey/sdk-server').TurnkeyApiClient} client */
export async function signTurnkeySdk(client, wire, address, organizationId) {
	const signer = new TurnkeySigner({ client, organizationId });
	const transaction = VersionedTransaction.deserialize(wire);
	const signed = await signer.signTransaction(transaction, address);
	return Buffer.from(signed.serialize());
}

/** @param {import('@turnkey/sdk-server').TurnkeyApiClient} client */
export async function signTurnkeyApi(client, wire, address) {
	const response = await client.signTransaction({
		signWith: address,
		unsignedTransaction: wire.toString("hex"),
		type: "TRANSACTION_TYPE_SOLANA",
	});
	if (
		response.activity.status !== "ACTIVITY_STATUS_COMPLETED" ||
		!response.signedTransaction
	) {
		throw new Error("Turnkey transaction activity did not complete");
	}
	return Buffer.from(response.signedTransaction, "hex");
}

/** @param {PrivyClient} client */
export async function signPrivy(client, wire, walletId, authorization_context) {
	const result = await client.wallets().solana().signTransaction(walletId, {
		transaction: wire,
		authorization_context,
	});
	if (result.encoding !== "base64")
		throw new Error("Unexpected Privy encoding");
	return Buffer.from(result.signed_transaction, "base64");
}

async function main() {
	const mode = checkConfiguration();
	if (process.argv[2] === "check") return;
	const timeout = setTimeout(() => {
		console.error(
			JSON.stringify({ mode, stage: "provider-sign", outcome: "timeout" }),
		);
		process.exit(1);
	}, 45_000);
	let stage = "decode-input";
	try {
		const wire = Buffer.from(readFileSync(0, "utf8").trim(), "base64");
		if (wire[0] !== 0x81 || wire.length > 4096)
			throw new Error("Expected v1 wire bytes under 4096 bytes");
		stage = mode === "turnkey-sdk" ? "solana-sdk" : "transaction-api";
		let signed;
		if (mode === "turnkey-sdk") {
			signed = await signTurnkeySdk(
				turnkeyClient(),
				wire,
				required("WALLET_ADDRESS"),
				required("TURNKEY_ORGANIZATION_ID"),
			);
		} else if (mode === "turnkey-api") {
			signed = await signTurnkeyApi(
				turnkeyClient(),
				wire,
				required("WALLET_ADDRESS"),
			);
		} else {
			const client = new PrivyClient({
				appId: required("PRIVY_APP_ID"),
				appSecret: required("PRIVY_APP_SECRET"),
				timeout: 30_000,
				maxRetries: 0,
			});
			const walletId = required("PRIVY_WALLET_ID");
			const wallet = await client.wallets().get(walletId);
			if (
				wallet.chain_type !== "solana" ||
				wallet.address !== required("WALLET_ADDRESS")
			) {
				throw new Error("Privy wallet ID does not match WALLET_ADDRESS");
			}
			signed = await signPrivy(client, wire, walletId, {
				user_jwts: process.env.PRIVY_USER_JWT
					? [process.env.PRIVY_USER_JWT]
					: [],
				authorization_private_keys: process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY
					? [process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY]
					: [],
			});
		}
		console.error(
			JSON.stringify({
				mode,
				stage,
				outcome: "returned-signed-bytes",
				bytes: signed.length,
			}),
		);
		process.stdout.write(signed.toString("base64"));
	} catch (error) {
		// Never print provider response bodies, JWTs, API credentials or requests.
		console.error(
			JSON.stringify({
				mode,
				stage,
				outcome: "failed",
				errorType: error.constructor.name,
			}),
		);
		process.exitCode = 1;
	} finally {
		clearTimeout(timeout);
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	main().catch(() => {
		console.error(
			"Provider configuration missing or invalid; see README environment table.",
		);
		process.exitCode = 1;
	});
}
