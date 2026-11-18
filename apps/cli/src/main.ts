#!/usr/bin/env bun
/**
 * ktb — the platform CLI composition root (P-098 A1).
 *
 * The CLI-side counterpart of apps/web: a thin shell that mounts
 * command packs contributed by packages/plugins. Today the only pack
 * is `eval` (@ktb/eval-cli — suite discovery over evals/, adapter
 * profiles, run/gate/report/calibrate/bench). New domains register
 * their `Command` subtree here.
 *
 *   ktb eval list|generate|run|gate|report|calibrate|bench …
 *
 * Exit codes inherit each pack's policy via the shared `teardown`:
 * 0 ok, 1 failure / enforced red gate, 2 usage error.
 */

import * as path from "node:path";
import { pathToFileURL } from "node:url";

import * as Effect from "effect/Effect";
import { Command, CliError } from "effect/cli";
import { NodeRuntime, NodeServices } from "@effect/platform-node";

import { defaultContext, makeEvalCommand, teardown, VERSION } from "@ktb/eval-cli";

const root = Command.make("ktb", {}, () =>
	Effect.fail(
		new CliError.ShowHelp({
			commandPath: ["ktb"],
			errors: [new CliError.MissingArgument({ argument: "<command>" })],
		}),
	),
).pipe(
	Command.withSubcommands([
		makeEvalCommand(defaultContext()),
		Command.make("help", {}, () =>
			Effect.fail(new CliError.ShowHelp({ commandPath: ["ktb"], errors: [] })),
		),
	]),
	Command.withDescription("KTB platform CLI — command packs: eval (suite runs, gates, reports)."),
);

/* v8 ignore next 3 -- entrypoint guard: only true when executed directly, never under vitest */
const invokedAs =
	process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (import.meta.url === invokedAs) {
	NodeRuntime.runMain(
		Command.run(root, { version: VERSION }).pipe(Effect.provide(NodeServices.layer)),
		{
			teardown,
		},
	);
}
