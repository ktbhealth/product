import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as fs from "node:fs";
import * as path from "node:path";

import type { Driver } from "@ktb/driver-framework";
import { EvalArtifacts } from "@ktb/eval-consultation";
import { PortError } from "@ktb/eval-core";

/**
 * Driver providing `EvalArtifacts` (P-081, T-133): serves run audio
 * for the in-app validator. Reads `file://` URIs under
 * `EVAL_RUNNER_DIR` only — any URI escaping the artifact root is
 * refused (path traversal guard: realpath must stay inside).
 */
export interface EvalArtifactsEnv {
	readonly EVAL_RUNNER_DIR?: string;
}

const stripFileScheme = (uri: string): string =>
	uri.startsWith("file://") ? uri.slice("file://".length) : uri;

export const evalArtifactsLocalDriver: Driver<EvalArtifactsEnv> = {
	id: "eval-artifacts-local",
	port: EvalArtifacts.key,
	when: (env) => Boolean(env.EVAL_RUNNER_DIR),
	provides: (env) => {
		const root = path.resolve(env.EVAL_RUNNER_DIR!);
		return Layer.succeed(
			EvalArtifacts,
			EvalArtifacts.of({
				getAudio: (uri) =>
					Effect.gen(function* () {
						let target: string;
						try {
							target = fs.realpathSync(stripFileScheme(uri));
						} catch {
							// Missing file → null (audio not synthesized yet).
							return null;
						}
						if (!target.startsWith(root + path.sep) && target !== root) {
							return yield* new PortError({
								port: "eval-artifacts",
								message: `uri outside artifact root: ${uri}`,
							});
						}
						return yield* Effect.try({
							try: () => new Uint8Array(fs.readFileSync(target)),
							catch: (e) => new PortError({ port: "eval-artifacts", message: String(e) }),
						});
					}),
			}),
		);
	},
};
