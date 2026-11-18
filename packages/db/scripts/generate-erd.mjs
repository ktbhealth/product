#!/usr/bin/env bun
/**
 * generate-erd — build a throwaway SQLite database from the Drizzle
 * migrations and render database docs into the sibling `docs` repo,
 * organized by owning plugin/package.
 *
 * Pipeline: drizzle/*.sql → better-sqlite3 → tbls doc / tbls out.
 * Requires `tbls` on PATH (https://github.com/k1LoW/tbls) or $TBLS_BIN.
 *
 * Usage: bun packages/db/scripts/generate-erd.mjs [--check] [--out <dir>]
 *        --check regenerates into a temp dir and diffs against the docs
 *        repo without writing; exits 1 on drift.
 *        --out overrides the docs content root (single target, no locales).
 */
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIZZLE_DIR = join(PKG_DIR, "drizzle");
const DOCS_REPO = resolve(PKG_DIR, "../../../docs");
const LOCALES = ["en", "pt-BR"];
const GENERATED_BY = "bun run db:erd (product/packages/db/scripts/generate-erd.mjs)";

// Table → owning plugin/package. `id` becomes the docs section name.
const DOMAINS = [
	{
		id: "patients",
		title: "Patients",
		owner: "`plugins/patients`",
		description:
			"Patient register — the clinical-administrative record for each person cared for, and their state-issued documents.",
		tables: ["patient_documents", "patients"],
	},
	{
		id: "consultations",
		title: "Consultations",
		owner: "`plugins/consultations`",
		description:
			"Consult records: transcript, anamnesis, review, audio pipeline state and patient linkage.",
		tables: ["consultations"],
	},
	{
		id: "groups",
		title: "Groups",
		owner: "`plugins/groups`",
		description: "Generic groups entity and memberships — clinics, teams, classes.",
		tables: ["group_members", "groups"],
	},
	{
		id: "integrity",
		title: "Integrity",
		owner: "`plugins/integrity`",
		description:
			"Tamper-evident record versioning — a content-addressed version chain per entity, anchoring anamnesis and blob hashes.",
		tables: ["record_versions"],
	},
	{
		id: "vault",
		title: "Vault",
		owner: "`plugins/vault`",
		description:
			"Zero-knowledge key custody — wrapped clinic keys and per-entity data encryption key grants.",
		tables: ["clinic_keys", "entity_deks", "portal_keys", "vault_secret"],
	},
	{
		id: "machines",
		title: "Machines",
		owner: "`plugins/machines`",
		description:
			"Platform machine registry — ACP/agent endpoint hosts with health/last-seen tracking.",
		tables: ["machine"],
	},
	{
		id: "notifications",
		title: "Notifications",
		owner: "`plugins/notifications`",
		description: "In-app notification inbox per user.",
		tables: ["notifications"],
	},
	{
		id: "audit",
		title: "Audit log",
		owner: "`plugins/audit`",
		description: "Admin audit trail — who changed what, when, on which target.",
		tables: ["admin_audit"],
	},
	{
		id: "pages",
		title: "Custom pages",
		owner: "`plugins/pages`",
		description: "Plugin-defined custom pages and their navigation placement.",
		tables: ["custom_pages"],
	},
	{
		id: "doctors",
		title: "Doctors",
		owner: "`plugins/doctors`",
		description:
			"Doctor profiles — the row that makes an account a doctor, with its professional data.",
		tables: ["doctors"],
	},
	{
		id: "secretaries",
		title: "Secretaries",
		owner: "`plugins/secretaries`",
		description: "Delegated access to a doctor profile — secretary invites and active delegations.",
		tables: ["doctor_access"],
	},
	{
		id: "patient-access",
		title: "Patient access",
		owner: "`plugins/patient-access`",
		description:
			"Patient portal grants — which account may open which patient record, and in what relation.",
		tables: ["patient_access"],
	},
	{
		id: "invites",
		title: "Invites",
		owner: "`plugins/invites`",
		description: "Single-use accept links sent in invite emails — only the token hash is stored.",
		tables: ["invite_tokens"],
	},
	{
		id: "auth",
		title: "Auth",
		owner: "`packages/db/src/auth.ts` (better-auth)",
		description:
			"better-auth core tables: users, sessions, OAuth accounts, verification tokens, and the api-key plugin table (AI credentials).",
		tables: ["account", "apikey", "session", "user", "verification"],
	},
	{
		id: "rbac",
		title: "RBAC",
		owner: "`packages/rbac` + `plugins/rbac`",
		description:
			"Roles, role-permission grants and subject (user/group) role assignments, with an epoch for cache invalidation.",
		tables: ["permission_epoch", "role_permissions", "roles", "subject_roles"],
	},
	{
		id: "platform",
		title: "Platform",
		owner: "`packages/db/src/plugin-state.ts`",
		description: "Kernel-owned state: per-plugin persisted configuration.",
		tables: ["plugin_state"],
	},
	{
		id: "jobs",
		title: "Jobs",
		owner: "`packages/db/src/job-runs.ts` + `packages/jobs-port` + `plugins/jobs`",
		description:
			"Generic jobs backbone status projection — one row per enqueued job (queued/processing/done/failed), read by the /platform jobs console.",
		tables: ["job_runs"],
	},
	{
		id: "eval-validator",
		title: "Eval validator",
		owner: "`plugins/eval-validator`",
		description:
			"Eval run tracking — step 3 of the eval pipeline: runs over a generation instance's approved items, per-sample metrics and diffs.",
		tables: ["eval_run", "eval_run_sample", "eval_run_record"],
	},
	{
		id: "ai-endpoints",
		title: "AI endpoints",
		owner: "`plugins/ai-provider`",
		description:
			"Generative providers (acp/openai) any AI surface binds through AiEndpoints.resolve — scoped per consuming surface with an is_default pick — plus the one-shot ai-bridge connect links.",
		tables: ["ai_agent_link", "ai_endpoint"],
	},
	{
		id: "ai-model",
		title: "AI model catalog",
		owner: "`plugins/ai-model`",
		description: "Platform model catalog — curated model entries AI surfaces resolve against.",
		tables: ["ai_model"],
	},
	{
		id: "ai-prompt",
		title: "AI prompts",
		owner: "`plugins/ai-prompt`",
		description: "Versioned prompt registry — named prompts with versioned bodies for AI surfaces.",
		tables: ["ai_prompt"],
	},
	{
		id: "eval-persona",
		title: "Eval persona",
		owner: "`plugins/eval-persona`",
		description:
			"Steps 1–2 of the eval pipeline — the persona registry (eval_persona_def) and consultation-generation instances whose items carry the synthetic corpus and the review gate (instances soft-link ai_endpoint).",
		tables: ["eval_instance", "eval_instance_item", "eval_persona_def"],
	},
	{
		id: "theme",
		title: "Theme",
		owner: "`plugins/theme`",
		description:
			"White-label theme definitions per scope (platform/tenant/portal-instance) — authored seeds, derived token maps, fonts, brand assets — plus the theme_assets upload pipeline.",
		tables: ["theme_assets", "theme_definitions"],
	},
	{
		id: "i18n",
		title: "Internationalization",
		owner: "`plugins/i18n` + `packages/i18n`",
		description:
			"DB-canonical localization — registered namespaces and locales, scoped message rows (global/tenant/portal) with draft/publish lifecycle, a single-row revision stamp for catalog caching, and the Loro CRDT op log behind staged rich-text edits.",
		tables: [
			"i18n_crdt_updates",
			"i18n_locales",
			"i18n_messages",
			"i18n_namespaces",
			"i18n_revision",
		],
	},
	{
		id: "kv",
		title: "Key/value state",
		owner: "`plugins/kv`",
		description:
			"TTL'd namespaced key/value store — durable small-state primitives (idempotency keys, rate limits, per-tenant flags, job checkpoints) with CAS versioning and tenant/owner scoping.",
		tables: ["kv_entries"],
	},
	{
		id: "document-store",
		title: "Document store",
		owner: "`plugins/document-store`",
		description:
			"Runtime data collections — plugins contribute schemas as data (document.collection kind); registry of collections plus JSON document records with tenant/owner fencing.",
		tables: ["document_collections", "document_records"],
	},
	{
		id: "wizards",
		title: "Wizards",
		owner: "`plugins/wizards`",
		description:
			"Declarative wizard definitions (steps, conditions, completion targets) and their per-owner run state.",
		tables: ["wizard_defs", "wizard_runs"],
	},
];

const TABLE_DOMAIN = new Map(DOMAINS.flatMap((d) => d.tables.map((t) => [t, d.id])));

const args = process.argv.slice(2);
const check = args.includes("--check");
const outFlag = args.indexOf("--out");
const outOverride = outFlag === -1 ? null : resolve(args[outFlag + 1]);

const tblsCandidates = [process.env.TBLS_BIN, "tbls", join(homedir(), "go/bin/tbls")];
let tbls = null;
for (const candidate of tblsCandidates) {
	if (!candidate) continue;
	try {
		execFileSync(candidate, ["version"], { stdio: "pipe" });
		tbls = candidate;
		break;
	} catch {
		// try next
	}
}
if (!tbls) {
	console.error(
		`tbls not found. Install it (go install github.com/k1LoW/tbls@latest, ` +
			`or download a release from https://github.com/k1LoW/tbls) ` +
			`and ensure it is on PATH, or set TBLS_BIN.`,
	);
	process.exit(1);
}

// 1. Apply every drizzle migration to a throwaway SQLite file, in journal order.
const tmp = execFileSync("mktemp", ["-d"], { encoding: "utf8" }).trim();
const dbFile = join(tmp, "ktb.db");
{
	const db = new Database(dbFile);
	const files = readdirSync(DRIZZLE_DIR)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	for (const f of files) db.exec(readFileSync(join(DRIZZLE_DIR, f), "utf8"));
	db.close();
	console.log(`applied ${files.length} migrations → ${dbFile}`);
}
const dsn = `sqlite://${dbFile}`;

// 2. tbls: per-table markdown (for table pages) + mermaid sources.
const stage = join(tmp, "doc");
execFileSync(tbls, ["doc", dsn, stage, "--force"], { stdio: "inherit" });
const mermaidFile = join(tmp, "schema.mmd");
execFileSync(tbls, ["out", dsn, "-t", "mermaid", "-o", mermaidFile], {
	stdio: "inherit",
});

const allTables = readdirSync(stage)
	.filter((f) => f.endsWith(".md") && f !== "README.md")
	.map((f) => f.replace(/\.md$/, ""));
const known = new Set(DOMAINS.flatMap((d) => d.tables));
const unknown = allTables.filter((t) => !known.has(t));
const missing = [...known].filter((t) => !allTables.includes(t));
if (unknown.length || missing.length) {
	console.error(
		`DOMAINS map out of sync with migrations.\n` +
			(unknown.length ? `  unmapped tables: ${unknown.join(", ")}\n` : "") +
			(missing.length ? `  mapped but absent: ${missing.join(", ")}\n` : ""),
	);
	process.exit(1);
}

const domainMermaid = {};
for (const d of DOMAINS) {
	const f = join(tmp, `domain-${d.id}.mmd`);
	execFileSync(tbls, ["out", dsn, "-t", "mermaid", "--include", d.tables.join(","), "-o", f], {
		stdio: "inherit",
	});
	domainMermaid[d.id] = readFileSync(f, "utf8").trim();
}

const QUAD_TITLES = {
	en: { reference: "Reference", "how-to": "How-to guides", tables: "Tables", dbIndex: "Database" },
	"pt-BR": {
		reference: "Referência",
		"how-to": "Guias práticos",
		tables: "Tabelas",
		dbIndex: "Banco de dados",
	},
};

// 3. Render one target tree into `root` (used for both write and --check).
//    `root` is the plugins/ docs dir; each domain becomes
//    plugins/<id>/{reference,how-to}/.
//    `existingBase` is the real docs dir (when known): how-to/ content is
//    hand-written, so its meta.json `pages` list is preserved from the
//    existing file and unknown pages are never wiped.
function renderTarget(root, locale, existingBase) {
	const qt = QUAD_TITLES[locale] ?? QUAD_TITLES.en;
	const base = root;
	// Docs URLs always carry the locale prefix and no file extension —
	// relative `.mdx` links do not resolve to pages (fumadocs emits them
	// as broken root-relative hrefs that fail prerendering).
	const docsBase = `/${locale}/docs/developers/plugins`;
	mkdirSync(base, { recursive: true });

	writeFileSync(
		join(base, "meta.json"),
		JSON.stringify(
			{ title: "Plugins", pages: ["index", ...DOMAINS.map((d) => d.id)] },
			null,
			"\t",
		) + "\n",
	);
	writeFileSync(join(base, "schema.mmd"), readFileSync(mermaidFile, "utf8"));

	for (const d of DOMAINS) {
		const dir = join(base, d.id);
		const refDir = join(dir, "reference");
		const tablesDir = join(refDir, "tables");
		const howToDir = join(dir, "how-to");
		mkdirSync(tablesDir, { recursive: true });
		mkdirSync(howToDir, { recursive: true });

		// Plugin landing pages and quadrant dirs are hand-written: list
		// index first when present, then every quadrant that exists (in
		// Diátaxis order). reference/ and how-to/ always exist.
		const QUADRANTS = ["tutorials", "how-to", "explanation", "reference"];
		const hasIndex =
			existingBase !== undefined && existsSync(join(existingBase, d.id, "index.mdx"));
		const quadrants = QUADRANTS.filter(
			(q) =>
				q === "reference" ||
				q === "how-to" ||
				(existingBase !== undefined && existsSync(join(existingBase, d.id, q))),
		);
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify(
				{ title: d.title, pages: [...(hasIndex ? ["index"] : []), ...quadrants] },
				null,
				"\t",
			) + "\n",
		);
		writeFileSync(
			join(refDir, "meta.json"),
			JSON.stringify({ title: qt.reference, pages: ["index", "tables"] }, null, "\t") + "\n",
		);
		writeFileSync(
			join(tablesDir, "meta.json"),
			JSON.stringify({ title: qt.tables, pages: d.tables }, null, "\t") + "\n",
		);
		// how-to guides are hand-written: keep the existing pages list so
		// regen never drops them (and --check compares like-for-like).
		let howToPages = [];
		if (existingBase) {
			const existing = join(existingBase, d.id, "how-to", "meta.json");
			if (existsSync(existing)) {
				try {
					howToPages = JSON.parse(readFileSync(existing, "utf8")).pages ?? [];
				} catch {
					/* malformed — regenerate empty */
				}
			}
		}
		writeFileSync(
			join(howToDir, "meta.json"),
			JSON.stringify({ title: qt["how-to"], pages: howToPages }, null, "\t") + "\n",
		);
		writeFileSync(join(refDir, "schema.mmd"), domainMermaid[d.id] + "\n");
		writeFileSync(
			join(refDir, "index.mdx"),
			`---\ntitle: ${JSON.stringify(qt.dbIndex)}\ndescription: ${JSON.stringify(
				`${d.title} database schema — ER diagram and per-table reference.`,
			)}\nicon: Network\n---\n\n{/* Generated by ${GENERATED_BY} — do not edit. */}\n\nOwned by ${d.owner}.\n\n## ER diagram\n\n\`\`\`mermaid\n${domainMermaid[d.id]}\n\`\`\`\n\nMermaid source: [\`schema.mmd\`](./schema.mmd)\n\n## Tables\n\n${d.tables
				.map((t) => `- [\`${t}\`](${docsBase}/${d.id}/reference/tables/${t})`)
				.join("\n")}\n`,
		);

		for (const table of d.tables) {
			const src = readFileSync(join(stage, `${table}.md`), "utf8");
			const title = src.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? table.replaceAll("_", " ");
			// Drop the per-table ER image (ugly tbls SVG); column docs remain.
			const body = src
				.replace(/^#\s+.+\n/, "")
				.replace(/^!\[.*\]\([^)]*\)\s*$/gm, "")
				// Cross-domain links: /<locale>/docs/developers/plugins/<domain>/reference/tables/<table>
				.replace(/\]\((?!https?:|#|\/)([a-z_]+)\.mdx?\)/g, (m, t) => {
					const target = TABLE_DOMAIN.get(t);
					return target ? `](${docsBase}/${target}/reference/tables/${t})` : m;
				});
			writeFileSync(
				join(tablesDir, `${table}.mdx`),
				`---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(
					`Database table \`${table}\` — columns, indexes and relations.`,
				)}\nicon: Table2\n---\n\n{/* Generated by ${GENERATED_BY} — do not edit. */}\n\n${body}`,
			);
		}
	}
}

// 4. Render each target into staging, then copy into the docs repo or diff.
//    A target is the plugins/ dir that receives the per-plugin sections.
//    --out DIR uses the same semantics.
const targets = outOverride
	? [{ dir: outOverride, locale: "en" }]
	: LOCALES.map((l) => ({
			dir: join(DOCS_REPO, "content/docs", l, "developers/plugins"),
			locale: l,
		}));

function collectFiles(dir, prefix = "") {
	const out = new Map();
	if (!existsSync(dir)) return out;
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const rel = prefix ? `${prefix}/${e.name}` : e.name;
		if (e.isDirectory()) {
			for (const [k, v] of collectFiles(join(dir, e.name), rel)) out.set(k, v);
		} else out.set(rel, readFileSync(join(dir, e.name), "utf8"));
	}
	return out;
}

const staged = targets.map(({ dir: checkBase, locale }, i) => {
	const renderRoot = join(tmp, `target-${i}`);
	renderTarget(renderRoot, locale, checkBase);
	return { checkBase, renderRoot };
});

let drift = false;
if (check) {
	for (const { checkBase, renderRoot } of staged) {
		const expected = collectFiles(renderRoot);
		// scope actual to generated names; index.mdx is hand-written
		const actual = collectFiles(checkBase);
		actual.delete("index.mdx");
		const diffs = [];
		for (const [rel, content] of expected) {
			const act = join(checkBase, rel);
			if (!existsSync(act)) diffs.push(`missing: ${rel}`);
			else if (readFileSync(act, "utf8") !== content) diffs.push(`content differs: ${rel}`);
		}
		for (const rel of actual.keys()) {
			// hand-written content is not generated output: how-to/tutorials/
			// explanation guides (their meta.json files are hand-maintained
			// too — only how-to/meta.json is regenerated with preserved pages)
			// and plugin index.mdx
			if (
				/^[^/]+\/(tutorials|how-to|explanation)\//.test(rel) &&
				rel !== `${rel.split("/")[0]}/how-to/meta.json`
			)
				continue;
			if (/^[^/]+\/index\.mdx$/.test(rel)) continue;
			if (!expected.has(rel)) {
				// Plugin dirs without a table domain are fully hand-written
				// (e.g. i18n's developer guide) — only flag files that carry
				// the generator's own do-not-edit marker.
				const domainOwned = new Set(DOMAINS.map((d) => d.id)).has(rel.split("/")[0]);
				const marked = readFileSync(join(checkBase, rel), "utf8").includes(GENERATED_BY);
				if (!domainOwned && !marked) continue;
				diffs.push(`stale (not generated): ${rel}`);
			}
		}
		if (diffs.length) {
			drift = true;
			console.log(`[${checkBase}] drift detected:`);
			for (const d of diffs) console.log(`  ${d}`);
		}
	}
	if (drift) {
		console.error("ERD docs are stale — run `bun run db:erd` and commit.");
		process.exit(1);
	}
	console.log("check passed: generated docs are up to date.");
} else {
	for (const { checkBase, renderRoot } of staged) {
		// wipe only generated artifacts; hand-written files survive:
		// plugins/index.mdx, and everything under plugins/<id>/how-to/
		// (only its meta.json is regenerated, preserving the pages list).
		rmSync(join(checkBase, "schema.mmd"), { force: true });
		rmSync(join(checkBase, "meta.json"), { force: true });
		for (const d of DOMAINS) {
			rmSync(join(checkBase, d.id, "reference"), { recursive: true, force: true });
			rmSync(join(checkBase, d.id, "meta.json"), { force: true });
		}
		for (const e of readdirSync(renderRoot, { withFileTypes: true })) {
			const src = join(renderRoot, e.name);
			const dest = join(checkBase, e.name);
			if (e.isDirectory()) {
				// merge contents — domain dirs may already exist (how-to/
				// is hand-written and preserved), so copy `src/.` not `src`.
				mkdirSync(dest, { recursive: true });
				// `src/.` (not join — it strips the dot) merges contents into
				// the existing dir instead of nesting src inside it.
				execFileSync("cp", ["-r", `${src}/.`, dest]);
			} else {
				execFileSync("cp", [src, dest]);
			}
		}
		console.log(`wrote plugin ERD docs → ${checkBase}`);
	}
}

rmSync(tmp, { recursive: true, force: true });
console.log("done.");
