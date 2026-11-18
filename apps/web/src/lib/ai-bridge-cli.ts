/**
 * ai-bridge-cli.ts — the argv prefix `createBridgeLinkFn` mints for the
 * `ai-bridge connect` command (F3b).
 *
 * `@ktb/ai-bridge` is unpublished, so `bunx @ktb/ai-bridge` 404s — dev
 * emits `bun <repo>/packages/ai-bridge/src/cli.ts` (resolved by the
 * caller from the module's own file URL; workerd dev serves real
 * source paths while prod bundles can't reach the monorepo anyway).
 * PUBLISHED_CLI is the prod path for the day the package ships;
 * AI_BRIDGE_CLI (binding/.dev.vars) overrides both — e.g. an installed
 * `ai-bridge` binary on the operator's PATH.
 *
 * Pure function so every arm is unit-testable; platform.ts passes the
 * resolved cli path and the vite env flag as data.
 */

export const PUBLISHED_AI_BRIDGE_CLI = "bunx @ktb/ai-bridge";

export const resolveAiBridgeCli = (input: {
	readonly override?: string | undefined;
	readonly dev?: boolean;
	readonly cliPath: string;
}): string =>
	input.override !== undefined && input.override !== ""
		? input.override
		: input.dev === true
			? `bun ${input.cliPath}`
			: PUBLISHED_AI_BRIDGE_CLI;
