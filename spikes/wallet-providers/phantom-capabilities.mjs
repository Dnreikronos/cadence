import { getWallets } from "./node_modules/@wallet-standard/app/lib/esm/wallets.js";

export function inspectPhantom(wallets) {
	const wallet = wallets.find((candidate) => candidate.name === "Phantom");
	if (!wallet)
		return {
			status: "not-found",
			versions: [],
			message:
				"Phantom has not registered. Open this page in the browser with Phantom enabled, then reload.",
		};
	const signing = wallet.features["solana:signTransaction"];
	if (!signing || !Array.isArray(signing.supportedTransactionVersions)) {
		return {
			status: "unknown",
			versions: [],
			message:
				"Phantom was detected, but its signing capabilities are unavailable. Compatibility is unverified.",
		};
	}
	const versions = [...signing.supportedTransactionVersions];
	if (!versions.includes(1)) {
		return {
			status: "unsupported",
			versions,
			message:
				"This Phantom installation does not advertise v1 transaction signing. Cadence’s confidential transfer is blocked with this wallet.",
		};
	}
	return {
		status: "advertised",
		versions,
		message:
			"Phantom advertises v1 signing. A real confidential transfer must still be signed and confirmed on devnet before compatibility is proven.",
	};
}

if (typeof document !== "undefined") {
	const registry = getWallets();
	const render = () => {
		const result = inspectPhantom(registry.get());
		document.getElementById("status").textContent = result.message;
		document.getElementById("evidence").textContent = JSON.stringify(
			{
				checkedAt: new Date().toISOString(),
				feature: "solana:signTransaction",
				...result,
			},
			null,
			2,
		);
	};
	registry.on("register", render);
	registry.on("unregister", render);
	document.getElementById("check").addEventListener("click", render);
	render();
}
