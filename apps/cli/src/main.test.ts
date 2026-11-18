import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Importing builds the command tree in-process (the runMain guard
// stays inert under vitest); the handlers themselves are exercised by
// the subprocess smoke tests below.
import "./main.ts";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** The CLI is a composition root — the only meaningful test is running
 * the real entrypoint and checking the help surface it mounts. Usage
 * errors exit non-zero by design, so capture status instead of
 * throwing. */
const run = (args: readonly string[]) => {
	const r = spawnSync(process.execPath, ["main.ts", ...args], {
		cwd: SRC,
		encoding: "utf8",
	});
	return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

describe("ktb cli entrypoint", () => {
	it("prints top-level help with the eval pack mounted", () => {
		const { out } = run([]);
		expect(out).toContain("ktb");
		expect(out).toContain("eval");
	});

	it("answers the help subcommand", () => {
		const { code, out } = run(["help"]);
		expect(code).toBe(0);
		expect(out).toContain("ktb");
	});
});
