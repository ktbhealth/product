/**
 * @ktb/eval-cli — the eval command pack for the platform CLI
 * (apps/cli). Exposes the `eval` command subtree bound to a CmdContext
 * plus the shared context/teardown helpers; the composition root owns
 * argv parsing and process exit.
 */

export { defaultContext, repoRoot, type CmdContext } from "./context.ts";
export { exitCodeOf, makeEvalCommand, run, teardown, VERSION } from "./cli.ts";
