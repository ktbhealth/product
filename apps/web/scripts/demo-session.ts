// Mint a better-auth session cookie for the seeded demo doctor against
// the prod D1, without going through the HTTP captcha gate. Rehearsal/
// verification helper only — the cookie is short-lived and printed to
// stdout for immediate use.
//
//   bun build scripts/demo-session.ts --outfile .demo-session.mjs \
//     --target node --external wrangler
//   cuora run --env prod --config ../../cuora.toml -- \
//     env SEED_PASSWORD=… node .demo-session.mjs
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getPlatformProxy } from "wrangler";

import { makeAuth } from "@ktb/auth-better";
import { makeDb } from "@ktb/db";

const EMAIL = process.env.SEED_EMAIL ?? "user@ktb.test";
const PASSWORD = process.env.SEED_PASSWORD ?? "dev-password-123";

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "2c03574ae47e534415b762ab3c474815";
process.env.CLOUDFLARE_ACCOUNT_ID ??= accountId;

const discoverProdDb = () => {
	const out = execFileSync("bunx", ["wrangler", "d1", "list", "--json"], {
		encoding: "utf8",
		cwd: process.cwd(),
		maxBuffer: 1024 * 1024,
		env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
	});
	const list = JSON.parse(out) as { name: string; uuid?: string }[];
	const name = process.env.SEED_D1_NAME ?? list.find((d) => /^ktb-web-db-prod-/.test(d.name))?.name;
	const id = process.env.SEED_D1_ID ?? list.find((d) => d.name === name)?.uuid;
	if (name === undefined || id === undefined) throw new Error("prod D1 not found");
	return { name, id };
};

const target = discoverProdDb();
const tmp = mkdtempSync(join(tmpdir(), "ktb-session-"));
const configPath = join(tmp, "wrangler.json");
writeFileSync(
	configPath,
	JSON.stringify({
		name: "ktb-session",
		compatibility_date: "2026-11-06",
		d1_databases: [
			{
				binding: "DB",
				database_name: target.name,
				database_id: target.id,
				remote: true,
			},
		],
	}),
);

const proxy = await getPlatformProxy({ configPath, remoteBindings: true });
try {
	const db = makeDb(proxy.env.DB as D1Database);
	const baseURL = process.env.BETTER_AUTH_URL;
	const auth = makeAuth(db, {
		secret: process.env.BETTER_AUTH_SECRET,
		baseURL,
	});
	const res = await auth.handler(
		new Request(`${baseURL}/api/auth/sign-in/email`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
		}),
	);
	const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
	if (!cookie.includes("=")) {
		throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
	}
	console.log(cookie);
} finally {
	await proxy.dispose();
	rmSync(tmp, { recursive: true, force: true });
}
