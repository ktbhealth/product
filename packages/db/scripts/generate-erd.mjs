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
 *        --out DIR writes a single (en) target tree — the plugins/ docs
 *        dir itself, e.g. --out /tmp/plugins-docs. Hand-written content
 *        is still read from the real docs repo for preservation.
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
			"Machine registry (P-098) — shells, VMs, GPU nodes and remote endpoints workloads (ACP agents, eval runners, transcription) can be scheduled onto. A registry, not a connection: consumers resolve a card and dial out via their own adapters; auth material lives in the vault (`secretRef` = `vault:<id>`).",
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
		title: "Pages",
		owner: "`plugins/pages`",
		description: "Plugin-defined pages and their navigation placement.",
		tables: ["pages"],
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
			"Role metadata, the relation_tuples grant graph (the only grant store since T-183), and an epoch for cache invalidation.",
		tables: ["permission_epoch", "relation_tuples", "roles"],
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
		id: "orchestrator",
		title: "Orchestrator",
		owner: "`packages/db/src/orchestration.ts` + `packages/orchestrator`",
		description:
			"Durable orchestration runs — persisted run state, the pending-event queue, per-node run trace, and stored orchestration definitions.",
		tables: [
			"orchestration_defs",
			"orchestration_events",
			"orchestration_node_runs",
			"orchestration_runs",
		],
	},
	{
		id: "scheduler",
		title: "Scheduler",
		owner: "`packages/db/src/scheduled-jobs.ts` + `packages/scheduler-port`",
		description:
			"Runtime schedule definitions — recurring (cron_expr) and one-off (run_at) rows claimed by the scheduler-heartbeat sweep and dispatched through the jobs backbone.",
		tables: ["scheduled_jobs"],
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
		id: "fonts",
		title: "Fonts",
		owner: "`plugins/fonts`",
		description:
			"Font provider registry — adapter-backed providers (local uploads, Google Fonts, extensible kinds) with synced family catalogs that cascade into theme font slots via hooks and events.",
		tables: ["font_families", "font_providers"],
	},
	{
		id: "rich-text",
		title: "Rich text",
		owner: "`plugins/rich-text`",
		description:
			"Reusable rich-text documents — titled content rows referenced by pages and other plugins.",
		tables: ["rich_text"],
	},
	{
		id: "images",
		title: "Images",
		owner: "`plugins/image`",
		description:
			"Managed media library — uploaded image metadata (title, alt text, mime, size, intrinsic dimensions, object-storage key) referenced by the site builder's `image` element kind and future referencers; bytes live in the bound bucket, rows make them reachable at `/api/images/:id`.",
		tables: ["images"],
	},
	{
		id: "schemas",
		title: "Schemas",
		owner: "`plugins/schemas`",
		description:
			"JSON Schema registry — named schemas used to validate plugin page params and other structured payloads.",
		tables: ["schemas"],
	},
	{
		id: "layouts",
		title: "Layouts",
		owner: "`plugins/layouts`",
		description:
			"Page-body layouts — named section compositions referenced by pages via `pages.layout_id`.",
		tables: ["layouts"],
	},
	{
		id: "templates",
		title: "Templates",
		owner: "`plugins/templates`",
		description:
			"Saved-as-template snapshots — kind-tagged payloads plugins instantiate into new entities.",
		tables: ["templates"],
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
		id: "agenda",
		title: "Agenda",
		owner: "`plugins/agenda`",
		description:
			"Doctor agenda — appointments booked against patients, their lifecycle status, and consultation linkage.",
		tables: ["appointments"],
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

// ── Plugin manifest scan ──────────────────────────────────────────
// Second generation pass: every plugins/* registry citizen gets a
// generated reference section — table-less plugins document their
// contributions instead of an ER diagram. Manifests import
// React/Effect and cannot be imported from this script, so
// src/index.ts is scanned statically for definePlugin({...}) literals
// (the same constraint tools/gen-db-schema.mjs works around for
// schema.ts).

const REPO_ROOT = resolve(PKG_DIR, "../..");
const PLUGINS_DIR = join(REPO_ROOT, "plugins");

// DOMAINS id → owning plugins/<pkg>, for entries that are plugin-owned.
// auth/platform/orchestrator/scheduler are package-owned (no plugins/*
// dir) and have no entry here. The values mark a pkg as already covered
// by the table pass — pass 2 skips them.
const DOMAIN_PKG = {
	patients: "patients",
	consultations: "consultations",
	groups: "groups",
	integrity: "integrity",
	vault: "vault",
	machines: "machines",
	notifications: "notifications",
	audit: "audit",
	pages: "pages",
	doctors: "doctors",
	secretaries: "secretaries",
	"patient-access": "patient-access",
	invites: "invites",
	"ai-endpoints": "ai-provider",
	"ai-model": "ai-model",
	"ai-prompt": "ai-prompt",
	"eval-validator": "eval-validator",
	"eval-persona": "eval-persona",
	theme: "theme",
	fonts: "fonts",
	"rich-text": "rich-text",
	images: "image",
	schemas: "schemas",
	layouts: "layouts",
	templates: "templates",
	i18n: "i18n",
	kv: "kv",
	agenda: "agenda",
	"document-store": "document-store",
	wizards: "wizards",
	rbac: "rbac",
	jobs: "jobs",
};

// docs section id overrides where the pkg name would collide with an
// existing section: DOMAINS `auth` documents the better-auth core
// tables (packages/db), while plugins/auth ships the auth routes and
// chrome contributions.
const PLUGIN_DOC_ID = { auth: "auth-plugin" };

// Dedicated contribution fields on the Plugin union (kernel
// contributions.ts) plus the additive generic channels. Order is the
// display order on generated reference pages.
const CONTRIBUTION_FIELDS = [
	"tables",
	"services",
	"routes",
	"landing",
	"chrome",
	"panel",
	"pages",
	"portals",
	"boundaries",
	"elementKinds",
	"middleware",
	"contributions",
	"pipelines",
	"orchestrations",
];
// String/comment/template-aware scanners — manifests embed JSX refs,
// arrow fns and nested objects, so braces can't be matched naively.
function skipString(src, i) {
	const quote = src[i];
	i++;
	while (i < src.length) {
		const c = src[i];
		if (c === "\\") {
			i += 2;
			continue;
		}
		if (c === quote) return i + 1;
		if (quote === "`" && c === "$" && src[i + 1] === "{") {
			i = skipBalanced(src, i + 1);
			continue;
		}
		i++;
	}
	return i;
}

function skipBalanced(src, i) {
	// src[i] is an opening bracket; returns the index just past its match.
	const CLOSERS = { "{": "}", "[": "]", "(": ")" };
	const stack = [CLOSERS[src[i]]];
	i++;
	while (i < src.length && stack.length > 0) {
		const c = src[i];
		const n = src[i + 1];
		if (c === "/" && n === "/") {
			const e = src.indexOf("\n", i + 2);
			i = e === -1 ? src.length : e + 1;
			continue;
		}
		if (c === "/" && n === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e === -1 ? src.length : e + 2;
			continue;
		}
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "{" || c === "[" || c === "(") stack.push(CLOSERS[c]);
		else if (c === "}" || c === "]" || c === ")") {
			if (stack.pop() !== c) return src.length; // unbalanced — bail
		}
		i++;
	}
	return i;
}

function skipWsComments(src, i) {
	while (i < src.length) {
		const c = src[i];
		if (/\s/.test(c)) {
			i++;
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const e = src.indexOf("\n", i + 2);
			i = e === -1 ? src.length : e + 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e === -1 ? src.length : e + 2;
			continue;
		}
		break;
	}
	return i;
}

// Depth-1 `key: value` pairs of the object literal opening at `open`
// (src[open] === "{"). Values are raw source slices.
function topLevelEntries(src, open) {
	const entries = [];
	let i = open + 1;
	while (i < src.length) {
		const c = src[i];
		if (c === "}") break;
		if (c === '"' || c === "'" || c === "`") {
			i = skipString(src, i);
			continue;
		}
		if (c === "/" && src[i + 1] === "/") {
			const e = src.indexOf("\n", i + 2);
			i = e === -1 ? src.length : e + 1;
			continue;
		}
		if (c === "/" && src[i + 1] === "*") {
			const e = src.indexOf("*/", i + 2);
			i = e === -1 ? src.length : e + 2;
			continue;
		}
		if (!/[A-Za-z_$]/.test(c)) {
			i++;
			continue;
		}
		const key = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 80))[0];
		const colon = skipWsComments(src, i + key.length);
		if (src[colon] !== ":") {
			i += key.length;
			continue;
		}
		const vstart = skipWsComments(src, colon + 1);
		let vend = vstart;
		while (vend < src.length) {
			const vc = src[vend];
			if (vc === '"' || vc === "'" || vc === "`") {
				vend = skipString(src, vend);
				continue;
			}
			if (vc === "/" && src[vend + 1] === "/") {
				const e = src.indexOf("\n", vend + 2);
				vend = e === -1 ? src.length : e + 1;
				continue;
			}
			if (vc === "/" && src[vend + 1] === "*") {
				const e = src.indexOf("*/", vend + 2);
				vend = e === -1 ? src.length : e + 2;
				continue;
			}
			if (vc === "{" || vc === "[" || vc === "(") {
				vend = skipBalanced(src, vend);
				continue;
			}
			if (vc === "," || vc === "}") break;
			vend++;
		}
		entries.push({ key, value: src.slice(vstart, vend).trim() });
		i = vend;
	}
	return entries;
}

// Every `const name = definePlugin({...})` in a manifest file.
function scanManifests(file) {
	const src = readFileSync(file, "utf8");
	const out = [];
	const re = /\b(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*definePlugin\s*\(\s*\{/g;
	let m;
	while ((m = re.exec(src))) {
		const open = m.index + m[0].length - 1;
		const end = skipBalanced(src, open);
		out.push({ name: m[1], entries: topLevelEntries(src, open) });
		re.lastIndex = end;
	}
	return out;
}

// First string literal at the start of `v` ('...', "..." or `...`).
function stringLiteral(v) {
	const m = /^("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/.exec(v);
	if (!m) return null;
	const raw = m[1];
	if (raw.includes("${")) return null; // interpolated — not static text
	return raw.slice(1, -1).replace(/\\(["'`\\])/g, "$1");
}

function entryValue(entries, key) {
	return entries.find((e) => e.key === key)?.value;
}

// name/description inside a `meta: {...}` value (raw object source).
function metaString(metaSrc, field) {
	if (!metaSrc) return null;
	const m = new RegExp(`(?:^|[{,\\s])${field}\\s*:`).exec(metaSrc);
	if (!m) return null;
	return stringLiteral(metaSrc.slice(m.index + m[0].length).trimStart());
}

// Plugin ids out of a deps array: `"literal.id"` strings and
// `somePlugin.id` references resolved through the const-name map.
function depIds(value, nameToId) {
	if (!value) return [];
	const ids = [];
	for (const m of value.matchAll(/["']([^"']+)["']|\b([A-Za-z_$][\w$]*)\.id\b/g)) {
		ids.push(m[1] ?? nameToId.get(m[2]) ?? `${m[2]}.id`);
	}
	return [...new Set(ids)];
}

const humanize = (s) =>
	s
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((w) => w[0].toUpperCase() + w.slice(1))
		.join(" ");

// Pass 1: scan every registry citizen's src/index.ts plus package-level
// manifest files (packages/*/src/index.ts — e.g. @ktb/platform ships
// platformAdminPlugin) to build the const-name → plugin-id map used to
// resolve `xPlugin.id` dependency references.
const manifestFiles = [];
{
	const pluginPkgs = readdirSync(PLUGINS_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	for (const pkg of pluginPkgs) {
		const f = join(PLUGINS_DIR, pkg, "src/index.ts");
		if (existsSync(f)) manifestFiles.push({ pkg, file: f });
	}
	const packagesDir = join(REPO_ROOT, "packages");
	for (const d of readdirSync(packagesDir, { withFileTypes: true })) {
		if (!d.isDirectory()) continue;
		const f = join(packagesDir, d.name, "src/index.ts");
		if (existsSync(f) && readFileSync(f, "utf8").includes("definePlugin(")) {
			manifestFiles.push({ pkg: null, file: f });
		}
	}
}

const nameToId = new Map();
const manifestsByPkg = new Map();
for (const { pkg, file } of manifestFiles) {
	const manifests = scanManifests(file);
	for (const man of manifests) {
		const id = stringLiteral(entryValue(man.entries, "id") ?? "");
		if (id) nameToId.set(man.name, id);
	}
	if (pkg) manifestsByPkg.set(pkg, manifests);
}

// Pass 2: aggregate per plugin package. Pkgs covered by a DOMAINS
// table section are skipped — they already have the full ER docs.
const coveredPkgs = new Set(Object.values(DOMAIN_PKG));
const PLUGIN_DOCS = [];
for (const pkg of [...manifestsByPkg.keys()].sort((a, b) => a.localeCompare(b))) {
	if (coveredPkgs.has(pkg)) continue;
	const manifests = manifestsByPkg.get(pkg);
	const srcDir = join(PLUGINS_DIR, pkg, "src");

	const pluginIds = [];
	const names = new Set();
	const descriptions = [];
	const kinds = new Set();
	const contributionHelpers = new Set();
	const requiredDeps = new Set();
	const optionalDeps = new Set();
	let priority = null;
	let system = false;

	for (const man of manifests) {
		const id = stringLiteral(entryValue(man.entries, "id") ?? "");
		if (id) pluginIds.push(id);
		const meta = entryValue(man.entries, "meta");
		const name = metaString(meta, "name");
		const description = metaString(meta, "description");
		if (name) names.add(name);
		if (description && !descriptions.includes(description)) descriptions.push(description);
		for (const e of man.entries) {
			if (CONTRIBUTION_FIELDS.includes(e.key)) {
				kinds.add(e.key);
				if (e.key === "contributions") {
					for (const h of e.value.matchAll(/\b([A-Za-z_$][\w$]*?)Contribution\s*\(/g)) {
						contributionHelpers.add(h[1]);
					}
				}
			}
		}
		for (const id2 of depIds(entryValue(man.entries, "requiredDeps"), nameToId)) {
			requiredDeps.add(id2);
		}
		for (const id2 of depIds(entryValue(man.entries, "optionalDeps"), nameToId)) {
			optionalDeps.add(id2);
		}
		const prio = stringLiteral(entryValue(man.entries, "priority") ?? "");
		if (prio) priority = prio;
		if (entryValue(man.entries, "system") === "true") system = true;
	}

	// Tables declared in src/schema.ts (if any) are already owned by a
	// DOMAINS section — cross-link rather than duplicate.
	const schemaTables = [];
	const schemaFile = join(srcDir, "schema.ts");
	if (existsSync(schemaFile)) {
		const schemaSrc = readFileSync(schemaFile, "utf8");
		for (const m of schemaSrc.matchAll(
			/\b(?:sqliteTable|tenantTable|pgTable)\s*\(\s*["'`]([\w$]+)["'`]/g,
		)) {
			schemaTables.push(m[1]);
		}
	}
	const ownedDomains = DOMAINS.filter((d) => d.tables.some((t) => schemaTables.includes(t))).map(
		(d) => d.id,
	);

	const apiFile = join(srcDir, "api.ts");
	const hasApi = existsSync(apiFile);
	const apiGroups = hasApi
		? [
				...readFileSync(apiFile, "utf8").matchAll(
					/export const (\w+) = (Query|Command|Event)\.group\(/g,
				),
			].map((m) => ({ name: m[1], kind: m[2] }))
		: [];

	const sourceFiles = ["index.ts"];
	if (hasApi) sourceFiles.push("api.ts");
	if (existsSync(join(srcDir, "schema.ts"))) sourceFiles.push("schema.ts");
	if (existsSync(join(srcDir, "fns.ts"))) sourceFiles.push("fns.ts");
	if (existsSync(join(srcDir, "routes"))) sourceFiles.push("routes/");
	if (existsSync(join(srcDir, "api-routes"))) sourceFiles.push("api-routes/");
	if (existsSync(join(srcDir, "views"))) sourceFiles.push("views/");

	const kindList = CONTRIBUTION_FIELDS.filter((k) => kinds.has(k));
	PLUGIN_DOCS.push({
		pkg,
		docsId: PLUGIN_DOC_ID[pkg] ?? pkg,
		title: names.size === 1 ? [...names][0] : humanize(pkg),
		description: descriptions[0] ?? null,
		pluginIds,
		kinds: kindList,
		contributionHelpers: [...contributionHelpers],
		requiredDeps: [...requiredDeps],
		optionalDeps: [...optionalDeps],
		priority,
		system,
		ownedDomains,
		hasApi,
		apiGroups,
		sourceFiles,
	});
}
PLUGIN_DOCS.sort((a, b) => a.docsId.localeCompare(b.docsId));
{
	const seen = new Set();
	for (const p of PLUGIN_DOCS) {
		if (seen.has(p.docsId) || DOMAINS.some((d) => d.id === p.docsId)) {
			console.error(`plugin docs id collision: ${p.docsId} (${p.pkg})`);
			process.exit(1);
		}
		seen.add(p.docsId);
	}
}

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
			{
				title: "Plugins",
				pages: ["index", ...DOMAINS.map((d) => d.id), ...PLUGIN_DOCS.map((p) => p.docsId)],
			},
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
		// how-to guides are hand-written: the pages list is derived from
		// the *.mdx files actually present in the docs tree (slug =
		// filename minus .mdx, sorted) so regen never drops them and
		// --check compares like-for-like.
		let howToPages = [];
		if (existingBase) {
			const howToRoot = join(existingBase, d.id, "how-to");
			if (existsSync(howToRoot)) {
				howToPages = readdirSync(howToRoot)
					.filter((f) => f.endsWith(".mdx"))
					.map((f) => f.slice(0, -".mdx".length))
					.sort();
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

	// Pass 2 — one reference-only section per plugins/* citizen that has
	// no DOMAINS table section. No tables/ dir and no schema.mmd: these
	// plugins own no DB tables (table-owning pkgs are all DOMAINS-covered).
	for (const p of PLUGIN_DOCS) {
		const dir = join(base, p.docsId);
		const refDir = join(dir, "reference");
		mkdirSync(refDir, { recursive: true });

		// Same quadrant convention as DOMAINS sections, minus the
		// always-present how-to/: reference/ is generated, the rest only
		// when a hand-written dir already exists in the docs tree.
		const QUADRANTS = ["tutorials", "how-to", "explanation", "reference"];
		const hasIndex =
			existingBase !== undefined && existsSync(join(existingBase, p.docsId, "index.mdx"));
		const quadrants = QUADRANTS.filter(
			(q) =>
				q === "reference" ||
				(existingBase !== undefined && existsSync(join(existingBase, p.docsId, q))),
		);
		writeFileSync(
			join(dir, "meta.json"),
			JSON.stringify(
				{ title: p.title, pages: [...(hasIndex ? ["index"] : []), ...quadrants] },
				null,
				"\t",
			) + "\n",
		);
		writeFileSync(
			join(refDir, "meta.json"),
			JSON.stringify({ title: qt.reference, pages: ["index"] }, null, "\t") + "\n",
		);

		const kindLabels = p.kinds.map((k) => (k === "contributions" ? "generic contributions" : k));
		const description =
			p.description ??
			`Plugin package \`plugins/${p.pkg}\` — contributes ${kindLabels.join(", ") || "registry entries"}.`;
		const lines = [
			`---`,
			`title: ${JSON.stringify(p.title)}`,
			`description: ${JSON.stringify(description)}`,
			`icon: Plug`,
			`---`,
			``,
			`{/* Generated by ${GENERATED_BY} — do not edit. */}`,
			``,
			`Plugin package \`plugins/${p.pkg}\` — ${p.pluginIds.length} manifest(s) in \`plugins/${p.pkg}/src/index.ts\`.`,
		];
		if (p.system || p.priority) {
			const flags = [
				...(p.system ? ["system plugin (cannot be disabled)"] : []),
				...(p.priority ? [`priority: \`${p.priority}\``] : []),
			];
			lines.push(``, `Flags: ${flags.join(" · ")}.`);
		}
		lines.push(``, `## Plugin ids`, ``);
		for (const id of p.pluginIds) lines.push(`- \`${id}\``);
		lines.push(``, `## Contributions`, ``);
		if (p.kinds.length === 0) {
			lines.push(`- (marker plugin — declares no contributions)`);
		}
		for (const k of p.kinds) {
			if (k === "contributions" && p.contributionHelpers.length > 0) {
				lines.push(
					`- \`contributions\` — generic kinds via ${p.contributionHelpers.map((h) => `\`${h}Contribution\``).join(", ")}`,
				);
			} else {
				lines.push(`- \`${k}\``);
			}
		}
		if (p.requiredDeps.length > 0 || p.optionalDeps.length > 0) {
			lines.push(``, `## Dependencies`, ``);
			if (p.requiredDeps.length > 0) {
				lines.push(`- required: ${p.requiredDeps.map((d) => `\`${d}\``).join(", ")}`);
			}
			if (p.optionalDeps.length > 0) {
				lines.push(`- optional: ${p.optionalDeps.map((d) => `\`${d}\``).join(", ")}`);
			}
		}
		if (p.hasApi) {
			lines.push(``, `## CQRS`, ``);
			if (p.apiGroups.length > 0) {
				lines.push(
					`\`plugins/${p.pkg}/src/api.ts\` defines ${p.apiGroups.length} group(s): ` +
						p.apiGroups.map((g) => `\`${g.name}\` (${g.kind})`).join(", ") +
						`.`,
				);
			} else {
				lines.push(
					`\`plugins/${p.pkg}/src/api.ts\` defines the CQRS surface (queries/commands/events).`,
				);
			}
		}
		if (p.ownedDomains.length > 0) {
			lines.push(``, `## Database`, ``);
			lines.push(
				`Tables owned by this package are documented under ` +
					p.ownedDomains.map((id) => `[\`${id}\`](${docsBase}/${id}/reference/)`).join(", ") +
					`.`,
			);
		}
		lines.push(``, `## Source`, ``);
		for (const f of p.sourceFiles) {
			lines.push(`- \`plugins/${p.pkg}/src/${f}\``);
		}
		writeFileSync(join(refDir, "index.mdx"), lines.join("\n") + "\n");
	}
}

// 4. Render each target into staging, then copy into the docs repo or diff.
//    A target is the plugins/ dir that receives the per-plugin sections.
//    `preserve` is the docs tree hand-written content (how-to guides,
//    plugin index.mdx, extra quadrants) is read from — normally the same
//    as `dir`; with --out it stays pointed at the real docs repo so the
//    scratch output matches what a real regen would produce.
const realEnPlugins = join(DOCS_REPO, "content/docs/en/developers/plugins");
const targets = outOverride
	? [{ dir: outOverride, locale: "en", preserve: realEnPlugins }]
	: LOCALES.map((l) => {
			const dir = join(DOCS_REPO, "content/docs", l, "developers/plugins");
			return { dir, locale: l, preserve: dir };
		});

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

const staged = targets.map(({ dir: checkBase, locale, preserve }, i) => {
	const renderRoot = join(tmp, `target-${i}`);
	const existingBase = existsSync(preserve) ? preserve : checkBase;
	renderTarget(renderRoot, locale, existingBase);
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
		// (its meta.json is regenerated with pages derived from the
		// *.mdx files present in the docs tree).
		rmSync(join(checkBase, "schema.mmd"), { force: true });
		rmSync(join(checkBase, "meta.json"), { force: true });
		for (const d of DOMAINS) {
			rmSync(join(checkBase, d.id, "reference"), { recursive: true, force: true });
			rmSync(join(checkBase, d.id, "meta.json"), { force: true });
		}
		// Pass-2 sections: same contract — generated reference/ + meta.json
		// are wiped, hand-written quadrants/index survive the merge copy.
		for (const p of PLUGIN_DOCS) {
			rmSync(join(checkBase, p.docsId, "reference"), { recursive: true, force: true });
			rmSync(join(checkBase, p.docsId, "meta.json"), { force: true });
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
