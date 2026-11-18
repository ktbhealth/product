#!/usr/bin/env bun
/**
 * coverage:report — turn vitest's `json-summary` coverage output into CI
 * artifacts (T-060). Runs in the coverage-gate job after
 * `vitest --mergeReports` has produced coverage/coverage-summary.json.
 *
 * Always:
 *   - appends a per-metric markdown table to $GITHUB_STEP_SUMMARY
 *     (falls back to stdout when the env var is unset)
 *   - copies coverage-summary.json and a parsed metrics.json into
 *     coverage-report/ — the directory uploaded as the `coverage-summary`
 *     workflow artifact. metrics.json + the copied summary become the
 *     baseline the next PR's sticky comment diffs against.
 *
 * With `--comment --baseline <path>`:
 *   - also writes coverage-report/comment.md — the sticky PR comment
 *     body, with per-metric coverage and delta vs the baseline
 *     coverage-summary.json (from the latest green main run's artifact).
 *     A missing/unreadable baseline degrades to "no baseline" deltas.
 *
 * Thresholds are read from vitest.config.ts so the pass/fail column
 * always matches what `vitest --mergeReports` enforces.
 *
 * Usage:
 *   bun tools/coverage-report.mjs [--comment] [--baseline <file>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SUMMARY_PATH = join(ROOT, "coverage", "coverage-summary.json");
const CONFIG_PATH = join(ROOT, "vitest.config.ts");
const OUT_DIR = join(ROOT, "coverage-report");

const METRICS = ["lines", "functions", "branches", "statements"];
const LABELS = {
	lines: "Lines",
	functions: "Functions",
	branches: "Branches",
	statements: "Statements",
};

function parseArgs(argv) {
	const args = { comment: false, baseline: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--comment") args.comment = true;
		else if (argv[i] === "--baseline") args.baseline = argv[++i];
	}
	return args;
}

/** Pull the numeric coverage thresholds out of vitest.config.ts. */
function readThresholds() {
	const thresholds = { lines: 100, functions: 100, branches: 100, statements: 100 };
	try {
		const config = readFileSync(CONFIG_PATH, "utf8");
		const block = config.match(/thresholds:\s*\{([^}]*)\}/);
		if (!block) return thresholds;
		for (const metric of METRICS) {
			const m = block[1].match(new RegExp(`${metric}:\\s*([\\d.]+)`));
			if (m) thresholds[metric] = Number(m[1]);
		}
	} catch {
		// Missing config → keep the 100% defaults.
	}
	return thresholds;
}

function readSummary(path) {
	const json = JSON.parse(readFileSync(path, "utf8"));
	return json.total ?? {};
}

const fmt = (pct) => `${Number(pct.toFixed(1))}%`;
const fmtDelta = (delta) => {
	const sign = delta > 0 ? "+" : delta < 0 ? "−" : "±";
	return `${sign}${Math.abs(delta).toFixed(1)}%`;
};
const status = (pct, threshold) => (pct >= threshold ? "pass" : "fail");

function summaryTable(metrics, thresholds) {
	const rows = METRICS.map(
		(m) =>
			`| ${LABELS[m]} | ${fmt(metrics[m].pct)} | ${fmt(thresholds[m])} | ${status(metrics[m].pct, thresholds[m])} |`,
	);
	return ["| Metric | Coverage | Threshold | Status |", "| --- | --- | --- | --- |", ...rows].join(
		"\n",
	);
}

function deltaTable(current, baseline) {
	if (!baseline) {
		return [
			"| Metric | Coverage | Δ vs base |",
			"| --- | --- | --- |",
			...METRICS.map((m) => `| ${LABELS[m]} | ${fmt(current[m].pct)} | — |`),
			"",
			"_No base-branch baseline available yet (first run after this change, or the latest main run has no coverage artifact)._",
		].join("\n");
	}
	return [
		"| Metric | Coverage | Δ vs base |",
		"| --- | --- | --- |",
		...METRICS.map((m) => {
			const delta = current[m].pct - baseline[m].pct;
			return `| ${LABELS[m]} | ${fmt(current[m].pct)} | ${fmtDelta(delta)} |`;
		}),
	].join("\n");
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!existsSync(SUMMARY_PATH)) {
		console.error(
			`coverage:report — ${SUMMARY_PATH} not found; run vitest with the json-summary reporter first.`,
		);
		process.exit(1);
	}
	const metrics = readSummary(SUMMARY_PATH);
	const thresholds = readThresholds();

	mkdirSync(OUT_DIR, { recursive: true });

	const stepSummary = process.env.GITHUB_STEP_SUMMARY;
	const summaryMd = `## Coverage report\n\n${summaryTable(metrics, thresholds)}\n`;
	if (stepSummary) {
		writeFileSync(stepSummary, summaryMd, { flag: "a" });
	} else {
		process.stdout.write(summaryMd);
	}

	// Artifact payload: verbatim summary (baseline for future PRs) plus
	// parsed totals for cheap diffing.
	writeFileSync(join(OUT_DIR, "coverage-summary.json"), readFileSync(SUMMARY_PATH));
	writeFileSync(
		join(OUT_DIR, "metrics.json"),
		JSON.stringify(
			{
				totals: Object.fromEntries(METRICS.map((m) => [m, metrics[m] ?? null])),
				thresholds,
			},
			null,
			2,
		),
	);

	if (args.comment) {
		let baseline = null;
		let baselineNote = "";
		if (args.baseline && existsSync(args.baseline)) {
			baseline = readSummary(args.baseline);
			const runId = process.env.BASELINE_RUN_ID;
			const server = process.env.GITHUB_SERVER_URL;
			const repo = process.env.GITHUB_REPOSITORY;
			if (runId && server && repo) {
				baselineNote = ` vs [main run #${runId}](${server}/${repo}/actions/runs/${runId})`;
			} else {
				baselineNote = " vs main";
			}
		}
		const comment = [
			`## Coverage report${baselineNote}`,
			"",
			deltaTable(metrics, baseline),
			"",
			"<details><summary>Thresholds</summary>",
			"",
			summaryTable(metrics, thresholds),
			"",
			"</details>",
			"",
			"_Enforced by vitest thresholds in `vitest.config.ts` via `coverage-gate`; HTML report in the `coverage-html` artifact._",
		].join("\n");
		writeFileSync(join(OUT_DIR, "comment.md"), comment);
	}
}

main();
