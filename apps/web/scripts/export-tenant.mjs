// Per-tenant ciphertext export (PL-007 F4 / T-150).
//
// Dumps every row scoped to one tenant (groups.id) plus the tenant's R2
// audio objects into a local directory. Everything written is exactly
// what the server stores — under the ZK rollout that means ciphertext
// plus the authz metadata the server legitimately sees (ids, tenantId,
// status, timestamps), never plaintext. The export is therefore safe to
// hold and ship; recovering readable records requires the clinic's keys
// on a client device, which is a separate ceremony by design.
//
// Requires `wrangler` (repo devDependency) authenticated against the
// Cloudflare account (CLOUDFLARE_API_TOKEN or `wrangler login`). Run
// from apps/web so wrangler resolves its version from node_modules:
//
//   node scripts/export-tenant.mjs --tenant 42
//   node scripts/export-tenant.mjs --tenant 42 --db ktb-web-db-prod-… \
//     --bucket ktb-web-audio-prod-… --out /mnt/backups/clinic-42
//
// --local targets the wrangler dev sandbox instead of prod (for dry
// runs of this script itself).
//
// Prod resource names carry a random Alchemy suffix
// (`<stack>-<id>-<stage>-<suffix>`); when --db/--bucket are omitted the
// script discovers them by listing and matching the stack prefix —
// pass them explicitly if discovery ever becomes ambiguous.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
	options: {
		tenant: { type: "string" },
		db: { type: "string" },
		bucket: { type: "string" },
		out: { type: "string" },
		local: { type: "boolean", default: false },
		help: { type: "boolean", short: "h", default: false },
	},
});

if (args.help || !args.tenant || !/^\d+$/.test(args.tenant)) {
	console.log(
		"Usage: node scripts/export-tenant.mjs --tenant <groups.id> " +
			"[--db <d1-name>] [--bucket <r2-name>] [--out <dir>] [--local]",
	);
	process.exit(args.help ? 0 : 2);
}
const tenantId = Number.parseInt(args.tenant, 10);
const scope = args.local ? "--local" : "--remote";

const wrangler = (...argv) =>
	execFileSync("bunx", ["wrangler", ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Resolve the Alchemy-provisioned name by stack-prefix match. */
function discover(list, predicate, label, explicit) {
	if (explicit) return explicit;
	const matches = list.filter(predicate);
	if (matches.length === 1) return matches[0];
	console.error(
		matches.length === 0
			? `error: no ${label} candidate found — pass --${label} explicitly`
			: `error: ambiguous ${label} candidates: ${matches.join(", ")} — pass --${label} explicitly`,
	);
	process.exit(2);
}

const dbName = discover(
	JSON.parse(wrangler("d1", "list", "--json")).map((d) => d.name),
	(n) => /^ktb-web-db-prod-/.test(n),
	"db",
	args.db,
);
const bucketName = discover(
	wrangler("r2", "bucket", "list")
		.split("\n")
		.map((l) => /^name:\s*(\S+)/.exec(l)?.[1])
		.filter(Boolean),
	(n) => n.includes("audio"),
	"bucket",
	args.bucket,
);

const outDir = path.resolve(
	args.out ?? `tenant-${tenantId}-export-${new Date().toISOString().replaceAll(":", "-")}`,
);
const dbDir = path.join(outDir, "db");
const audioDir = path.join(outDir, "audio");
mkdirSync(dbDir, { recursive: true });
mkdirSync(audioDir, { recursive: true });

// Capture the current D1 bookmark so the export can be correlated with
// Time Travel later (restore to a known state before/after the dump).
let bookmark = null;
if (!args.local) {
	try {
		bookmark = JSON.parse(wrangler("d1", "time-travel", "info", dbName, "--json")).bookmark ?? null;
	} catch {
		console.warn("warn: could not capture D1 bookmark — manifest will record null");
	}
}

/**
 * Tables carrying tenant-scoped data. `column` is matched against the
 * tenant id; `text: true` marks columns whose tenant id is stored as
 * TEXT (relation_tuples.tenant_id — the RBAC assignment scope since
 * T-183 dropped subject_roles) and needs a quoted comparison.
 *
 * PL-007 F2 adds `clinic_keys` + `entity_deks` — append them here when
 * that schema lands (wrapped key material is ciphertext too, and MUST
 * be exported or a restored tenant loses access to its own records).
 */
const TENANT_TABLES = [
	{ table: "groups", column: "id" },
	{ table: "group_members", column: "group_id" },
	{ table: "patients", column: "tenant_id" },
	{ table: "consultations", column: "tenant_id" },
	{ table: "admin_audit", column: "tenant_id" },
	{ table: "job_runs", column: "tenant_id" },
	{ table: "relation_tuples", column: "tenant_id", text: true },
];

const sql = (q) => {
	// `d1 execute --json` prints a JSON array of result sets; each entry's
	// `results` is the row list. Some wrangler versions wrap output in
	// non-JSON noise on stderr — stdout stays clean JSON.
	const raw = wrangler("d1", "execute", dbName, scope, "--json", "--command", q);
	return JSON.parse(raw).flatMap((rs) => rs.results ?? []);
};

const rowCounts = {};
const audioKeys = new Set();
for (const { table, column, text } of TENANT_TABLES) {
	const value = text ? `'${tenantId}'` : String(tenantId);
	const rows = sql(`SELECT * FROM ${table} WHERE ${column} = ${value}`);
	writeFileSync(path.join(dbDir, `${table}.json`), JSON.stringify(rows, null, "\t"));
	rowCounts[table] = rows.length;
	for (const row of rows) {
		if (typeof row.audio_key === "string" && row.audio_key.length > 0) audioKeys.add(row.audio_key);
	}
	console.log(`db/${table}.json — ${rows.length} row(s)`);
}

const audioFiles = [];
for (const key of audioKeys) {
	// Keys are server-generated (`audio/<id>.<ext>`); basename only so a
	// malformed key can never escape audioDir.
	const file = path.join(audioDir, path.basename(key));
	wrangler("r2", "object", "get", `${bucketName}/${key}`, scope, "--file", file);
	audioFiles.push({ key, file: `audio/${path.basename(key)}` });
	console.log(`audio/${path.basename(key)} — ${key}`);
}

writeFileSync(
	path.join(outDir, "manifest.json"),
	JSON.stringify(
		{
			kind: "ktb-tenant-export",
			version: 1,
			exportedAt: new Date().toISOString(),
			tenantId,
			d1: { database: dbName, bookmarkAtExport: bookmark },
			r2: { bucket: bucketName },
			rowCounts,
			audioFiles,
			note: "Ciphertext export. Under ZK, row contents decrypt only with the clinic's keys on a member device — this archive alone yields no plaintext.",
		},
		null,
		"\t",
	),
);
console.log(`\nexport complete → ${outDir}`);
