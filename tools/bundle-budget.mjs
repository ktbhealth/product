#!/usr/bin/env bun
/**
 * bundle:budget — guard the Cloudflare Worker bundle against the
 * platform size limit (T-063). Runs in the bundle-budget CI job after
 * `vp build` has produced apps/web/dist/server (the deployable worker
 * output consumed by Alchemy with `bundle: false`, see
 * apps/web/alchemy.run.ts → infra/cloudflare cloudflareWorker).
 *
 * What counts: Cloudflare's documented "Worker size" limit is the
 * UNCOMPRESSED total upload — 64 MiB on both Free and Paid plans
 * (developers.cloudflare.com/workers/platform/limits). There is no
 * compressed-size limit; wrangler's gzip figure is informational only
 * (changelog 2026-09-04, "Deploy larger Workers"). The upload is the
 * ES-module graph rooted at dist/server/index.js — every .js/.mjs
 * chunk plus .wasm modules under dist/server. Sourcemaps (.map) are
 * not modules and are excluded; dist/client is static assets with its
 * own per-file limit, not part of the worker script.
 *
 * Budget: 48 MiB uncompressed — ~25% headroom under the 64 MiB limit,
 * leaving room for dependency growth while still failing loudly well
 * before a deploy would be rejected. Gzip size is still reported for
 * reference (it tracks what the old compressed limit used to gate).
 *
 * Always:
 *   - appends a markdown report to $GITHUB_STEP_SUMMARY (falls back to
 *     stdout when unset): total uncompressed + gzip sizes, top files,
 *     budget, pass/fail, and delta vs --baseline when provided
 *   - writes bundle-size/bundle-size.json — uploaded as the
 *     `bundle-size` workflow artifact; the next PR's run downloads the
 *     latest main artifact and diffs against it
 *
 * With `--baseline <path>`:
 *   - reads a previous bundle-size.json and adds a Δ column/section.
 *     A missing/unreadable baseline degrades to "no baseline".
 *
 * Usage:
 *   bun tools/bundle-budget.mjs [--baseline <file>]
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = new URL("..", import.meta.url).pathname;
const WORKER_DIR = join(ROOT, "apps", "web", "dist", "server");
const OUT_DIR = join(ROOT, "bundle-size");

// Cloudflare Workers "Worker size" limit — uncompressed total upload.
// Source: https://developers.cloudflare.com/workers/platform/limits/
// (64 MiB on Free and Paid; compressed size is NOT limited — the gzip
// figure wrangler prints is reference-only since 2026-09-04).
const CF_LIMIT_BYTES = 64 * 1024 * 1024;
// Fail at ~75% of the platform limit so dependency growth is caught in
// CI long before `alchemy deploy` would be rejected.
const BUDGET_BYTES = 48 * 1024 * 1024;

const MODULE_EXTENSIONS = new Set([".js", ".mjs", ".wasm"]);

function parseArgs(argv) {
	const args = { baseline: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--baseline") args.baseline = argv[++i];
	}
	return args;
}

/** Recursively collect worker module files (.js/.mjs/.wasm, no maps). */
function collectModules(dir, out = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			collectModules(path, out);
		} else if (entry.isFile()) {
			const dot = entry.name.lastIndexOf(".");
			const ext = dot === -1 ? "" : entry.name.slice(dot);
			// .map files are sourcemaps — uploaded for observability, never
			// part of the module graph, so they don't count toward size.
			if (MODULE_EXTENSIONS.has(ext) && !entry.name.endsWith(".map")) {
				out.push(path);
			}
		}
	}
	return out;
}

const fmtKiB = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
const fmtMiB = (bytes) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
const fmtDelta = (delta) => {
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
	return `${sign}${fmtMiB(Math.abs(delta))}`;
};

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(WORKER_DIR)) {
		console.error(`bundle:budget — ${WORKER_DIR} not found; run the build (vp build) first.`);
		process.exit(1);
	}

	const files = collectModules(WORKER_DIR)
		.map((path) => {
			const raw = readFileSync(path);
			return {
				path: relative(ROOT, path),
				size: statSync(path).size,
				gzip: gzipSync(raw).length,
			};
		})
		.sort((a, b) => b.size - a.size);

	const total = files.reduce((sum, f) => sum + f.size, 0);
	const totalGzip = files.reduce((sum, f) => sum + f.gzip, 0);
	const overBudget = total > BUDGET_BYTES;

	let baseline = null;
	let baselineNote = "";
	if (args.baseline && existsSync(args.baseline)) {
		try {
			baseline = JSON.parse(readFileSync(args.baseline, "utf8"));
			const runId = process.env.BASELINE_RUN_ID;
			const server = process.env.GITHUB_SERVER_URL;
			const repo = process.env.GITHUB_REPOSITORY;
			if (runId && server && repo) {
				baselineNote = ` vs [main run #${runId}](${server}/${repo}/actions/runs/${runId})`;
			} else {
				baselineNote = " vs main";
			}
		} catch {
			baseline = null;
		}
	}

	const top = files.slice(0, 10);
	const delta = baseline?.total ? total - baseline.total : null;
	const status = overBudget ? "fail" : "pass";

	const lines = [
		`## Worker bundle budget${baselineNote}`,
		"",
		`| Metric | Size |`,
		`| --- | --- |`,
		`| Uncompressed (counts toward limit) | ${fmtMiB(total)} |`,
		`| Gzip (reference only — no CF limit) | ${fmtMiB(totalGzip)} |`,
		`| Budget | ${fmtMiB(BUDGET_BYTES)} |`,
		`| Cloudflare limit | ${fmtMiB(CF_LIMIT_BYTES)} uncompressed |`,
		`| Modules | ${files.length} files |`,
		...(delta !== null ? [`| Δ vs base | ${fmtDelta(delta)} |`] : []),
		`| Status | ${status.toUpperCase()} |`,
		"",
		"<details><summary>Largest modules</summary>",
		"",
		"| File | Uncompressed | Gzip |",
		"| --- | --- | --- |",
		...top.map((f) => `| \`${f.path}\` | ${fmtKiB(f.size)} | ${fmtKiB(f.gzip)} |`),
		...(files.length > top.length ? ["", `_…and ${files.length - top.length} more_`] : []),
		"",
		"</details>",
		"",
		`_Enforced by \`tools/bundle-budget.mjs\` against the Cloudflare Workers uncompressed size limit (${fmtMiB(CF_LIMIT_BYTES)}; compressed size is not limited)._`,
	];
	const report = lines.join("\n");

	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	if (stepSummary) {
		writeFileSync(stepSummary, report, { flag: "a" });
	} else {
		process.stdout.write(report);
	}

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		join(OUT_DIR, "bundle-size.json"),
		JSON.stringify(
			{
				total,
				totalGzip,
				budget: BUDGET_BYTES,
				cfLimit: CF_LIMIT_BYTES,
				fileCount: files.length,
				files: files.map(({ path, size, gzip }) => ({ path, size, gzip })),
			},
			null,
			2,
		),
	);

	if (overBudget) {
		console.error(
			`bundle:budget — FAIL: worker bundle is ${fmtMiB(total)} uncompressed, over the ${fmtMiB(BUDGET_BYTES)} budget (${fmtMiB(CF_LIMIT_BYTES)} CF limit).`,
		);
		process.exit(1);
	}
}

main();
