import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const routes = new Map([
	["/", ["phantom.html", "text/html; charset=utf-8"]],
	[
		"/phantom-capabilities.mjs",
		["phantom-capabilities.mjs", "text/javascript; charset=utf-8"],
	],
	[
		"/node_modules/@wallet-standard/app/lib/esm/wallets.js",
		[
			"node_modules/@wallet-standard/app/lib/esm/wallets.js",
			"text/javascript; charset=utf-8",
		],
	],
]);

export function createPhantomServer() {
	return createServer(async (request, response) => {
		const route = routes.get(request.url);
		if (request.method !== "GET" || !route) {
			response.writeHead(404).end();
			return;
		}
		try {
			const contents = await readFile(new URL(route[0], import.meta.url));
			response
				.writeHead(200, {
					"Content-Type": route[1],
					"Cache-Control": "no-store",
					"X-Content-Type-Options": "nosniff",
					"Content-Security-Policy":
						"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
				})
				.end(contents);
		} catch {
			response.writeHead(500).end("Cannot load compatibility page");
		}
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	createPhantomServer().listen(8787, "127.0.0.1", () => {
		console.log("Phantom compatibility check: http://127.0.0.1:8787");
	});
}
