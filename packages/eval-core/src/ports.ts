import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";

import type {
	CalibrationReport,
	DatasetManifest,
	EditList,
	EvalAnswer,
	EvalQuestion,
	Experiment,
	RunRecord,
} from "./schema.ts";

/**
 * Eval-core ports — the GENERIC hexagonal boundary every suite shares:
 * the shared failure type, the ACP task envelope, the typed decision
 * port, and the run-record sink. Domain ports (TTS, ASR, dataset
 * store) are contributed by domain packs/adapters on top of these.
 * No platform APIs, no provider literals.
 */

/** Single shared failure type — the port name identifies which
 * adapter failed; `cause` chains for diagnostics. */
export class PortError extends Data.TaggedError("PortError")<{
	readonly port: string;
	readonly message: string;
	readonly cause?: unknown;
}> {}

/** ACP task envelope — the unit of delegated generation. EVERY
 * generative call goes through this shape (no raw-string shortcuts):
 * the envelope carries identity, output contract, and cost bounds so
 * sessions stay traceable and budgetable. */
export interface TaskEnvelope {
	readonly taskId: string;
	readonly role: "generator" | "corrector";
	readonly input: string;
	/** Declared output contract — ACP sessions validate against it
	 * (e.g. "EditList" for correct). */
	readonly outputSchema: string;
	readonly seed?: number;
	readonly modelHint?: string;
}

/** Structured DECISION port (System One/Jev typed questions) — the
 * decision-model boundary, NOT a generative port: answers are bounded
 * typed values with calibrated probabilities. `judge` is the
 * eval-stage consumer (the suite runner's verdict stage); other
 * consumers (cleanup gates, platform decisions) share the same
 * contract. Historically named `EvalPort` — that name remains as an
 * alias of this class so existing call sites keep working, and the
 * service KEY deliberately keeps its `@ktb/eval-core/EvalPort` string:
 * contribution meta (`eval.capability`/`eval.stage` `port` fields) and
 * any serialized references key on it, so the string must not drift. */
export class DecisionsPort extends Context.Service<
	DecisionsPort,
	{
		/** Whether `state` may leave the perimeter (remote decision
		 * service vs in-process). Informational for the domain PHI
		 * policy — judge state is scrubbed upstream — declared so the
		 * capability is explicit like the other ports. */
		readonly egress?: boolean;
		readonly judge: (input: {
			readonly state: unknown;
			readonly questions: readonly EvalQuestion[];
		}) => Effect.Effect<{ answers: readonly EvalAnswer[]; record: RunRecord }, PortError>;
	}
>()("@ktb/eval-core/EvalPort") {}

/** Back-compat alias — `EvalPort` IS `DecisionsPort` (same class object,
 * same Context tag identity), so `Layer.succeed(EvalPort, …)`,
 * `Effect.serviceOption(EvalPort)` and `DecisionsPort`-typed lookups
 * interoperate freely. New code should say `DecisionsPort`. */
export { DecisionsPort as EvalPort };

/** Run-record sink + report rendering. */
export class ReportPort extends Context.Service<
	ReportPort,
	{
		readonly append: (record: RunRecord) => Effect.Effect<void, PortError>;
		/** Render a run's report — markdown table via `renderRunMarkdown`
		 * (the shape is part of the contract, not adapter-defined). */
		readonly render: (runId: string) => Effect.Effect<string, PortError>;
	}
>()("@ktb/eval-core/ReportPort") {}

/** Framework-level artifact store (P-076) — the market-parity half of
 * persistence, sibling to the domain packs' DatasetStorePort:
 *
 *   - experiments: one Experiment per `eval run`/`eval generate`
 *   - dataset manifests: the registry `eval generate` writes and
 *     `eval list --strict` validates suite dataset pins against
 *   - calibration reports: `eval calibrate` judge-vs-gold output
 *
 * These records are cross-suite (a dataset manifest is shared
 * registry state, not one suite's rows), which is why they live on
 * their own port rather than the domain store. All three collections
 * are keyed by content id and upsert on rewrite — EXCEPT
 * putDatasetManifest, which enforces registry semantics: re-registering
 * the same id+version with a DIFFERENT contentHash is a PortError
 * (regenerate under a new version instead of silently drifting the
 * pin); the same contentHash is an idempotent no-op. */
export class EvalStorePort extends Context.Service<
	EvalStorePort,
	{
		readonly putExperiment: (experiment: Experiment) => Effect.Effect<void, PortError>;
		readonly getExperiment: (id: string) => Effect.Effect<Experiment | null, PortError>;
		readonly listExperiments: (filter?: {
			readonly suiteId?: string;
		}) => Effect.Effect<readonly Experiment[], PortError>;

		readonly putDatasetManifest: (manifest: DatasetManifest) => Effect.Effect<void, PortError>;
		readonly getDatasetManifest: (
			id: string,
			version: string,
		) => Effect.Effect<DatasetManifest | null, PortError>;
		readonly listDatasetManifests: () => Effect.Effect<readonly DatasetManifest[], PortError>;

		readonly putCalibrationReport: (report: CalibrationReport) => Effect.Effect<void, PortError>;
		readonly listCalibrationReports: (filter?: {
			readonly suiteId?: string;
			runId?: string;
		}) => Effect.Effect<readonly CalibrationReport[], PortError>;
	}
>()("@ktb/eval-core/EvalStorePort") {}

// ---------------------------------------------------------------------------
// Generative/decision ENDPOINT contracts — moved here from
// `@ktb/eval-consultation` (which re-exports them) so production
// surfaces (plugins/pipeline-transcript, app-host, ai-provider) depend
// on this infra package instead of the evals/ workspace domain pack.
// The service KEY strings deliberately keep their historical
// `@ktb/eval-consultation/…` spelling: serialized service references
// key on those strings, so they must not drift — same precedent as
// `DecisionsPort`'s `@ktb/eval-core/EvalPort` key.
// ---------------------------------------------------------------------------

/** Generative model port — ACP-delegated in live adapters.
 * `egress` declares whether envelope input text may leave the
 * perimeter (remote agent vs in-process); the pipeline only ever sends
 * scrubbed text, so this is informational today — declared for the
 * same structural policy as the other ports. */
export class LlmPort extends Context.Service<
	LlmPort,
	{
		readonly egress?: boolean;
		readonly generate: (
			envelope: TaskEnvelope,
		) => Effect.Effect<{ text: string; record: RunRecord }, PortError>;
		/** Surface correction: returns a reversible edit list, never a
		 * rewritten blob — edits stay auditable/rollback-able. */
		readonly correct: (
			envelope: TaskEnvelope,
		) => Effect.Effect<{ edits: EditList; record: RunRecord }, PortError>;
	}
>()("@ktb/eval-consultation/LlmPort") {}

/** Provider descriptor for a generative endpoint — the rows the eval
 * lab's endpoint CRUD persists. `kind` selects the wire protocol:
 * `acp` = JSON-RPC agent transport (Claude Code, Gemini CLI, custom
 * agents); `openai` = OpenAI-compatible chat completions (Ollama, LM
 * Studio, GPT, Gemini's compat endpoint); `systemone` = a System One
 * decision-model endpoint (`POST /v1/systemone`) — NOT generative, so
 * it resolves through DecisionsFactory/DecisionsPort, never LlmFactory.
 * `secretRef` is the NAME of
 * an env var holding the API key — keys never live in tables. */
export interface LlmEndpointDescriptor {
	readonly kind: "acp" | "openai" | "systemone";
	/** Optional for acp+ws bridge endpoints (F3b): absent/empty means
	 * "connect through the AcpBridge durable object" — the agent lives
	 * behind a local ai-bridge CLI, not a URL. */
	readonly baseUrl: string;
	/** Owning ai_endpoint row id — set by the plugin's descriptor
	 * resolution; the bridge DO names itself `idFromName(endpointId)`. */
	readonly endpointId?: number;
	readonly model?: string;
	readonly sessionId?: string;
	readonly secretRef?: string;
	/** ACP transport — `ws` is the HTTP/WebSocket path adapters in this
	 * runtime support; `child`/`ssh` require a Node-runtime driver and
	 * resolve to a PortError under workerd. Absent = `ws`. */
	readonly transport?: "ws" | "child" | "ssh";
	/** Agent command for `child`/`ssh` ACP transports — e.g.
	 * `claude-agent-acp` or `gemini --acp`. Spawned by
	 * @ktb/ai-adapter-node; unused by `ws`/`openai`. */
	readonly agentCmd?: string;
	/** SSH target (`user@host`) for the `ssh` ACP transport — the
	 * `agentCmd` runs on that host. Unused by `child`/`ws`. */
	readonly sshHost?: string;
	/** Raw API key resolved server-side (e.g. from the credentials
	 * store) — never persisted on the endpoint row. */
	readonly apiKey?: string;
	readonly timeoutMs?: number;
}

/** A starter endpoint for the eval lab's endpoint form — surfaced by
 * the bound adapter so provider endpoints stay in the exempt edge
 * (the arch preset bans provider literals in port/domain code). `label`
 * is the UI-facing chip name; the rest pre-fills the form fields. */
export interface LlmEndpointPreset {
	readonly label: string;
	readonly kind: LlmEndpointDescriptor["kind"];
	readonly baseUrl: string;
	readonly model?: string;
}

/** Factory port — resolves an endpoint descriptor into a bound
 * LlmPort layer on demand. Lives next to the other eval ports so
 * plugins (eval lab) can build per-endpoint generators without
 * importing adapters: the composition root binds one factory and the
 * plugin asks it for concrete ports. `test` is a liveness ping used
 * by the endpoint CRUD's "test connection" action. `presets` is the
 * adapter's list of provider starter endpoints the endpoint dialog
 * offers as one-click chips — optional since adapters may know no
 * hosted providers. */
export class LlmFactory extends Context.Service<
	LlmFactory,
	{
		readonly resolve: (
			descriptor: LlmEndpointDescriptor,
		) => Effect.Effect<Layer.Layer<LlmPort>, PortError>;
		readonly test: (descriptor: LlmEndpointDescriptor) => Effect.Effect<void, PortError>;
		readonly presets?: readonly LlmEndpointPreset[];
	}
>()("@ktb/eval-consultation/LlmFactory") {}

/**
 * Platform-default generative endpoint for PRODUCTION surfaces
 * (transcript cleanup, anamnesis extraction) — bound by the
 * ai-provider plugin's services layer. `defaultLayer` resolves the
 * enabled `scope='platform'` `is_default` endpoint through LlmFactory
 * on every call, so admin changes apply without a restart; `null`
 * means "no platform default configured" and consumers fall back to
 * env-derived provider config, then their deterministic path. Absent
 * service (plugin not registered) is the same fallback — read it via
 * `Effect.serviceOption`.
 */
export class PlatformLlm extends Context.Service<
	PlatformLlm,
	{
		readonly defaultLayer: () => Effect.Effect<Layer.Layer<LlmPort> | null, never, unknown>;
	}
>()("@ktb/eval-consultation/PlatformLlm") {}

/**
 * Factory port for DECISION endpoints — the `systemone` kind of the
 * shared `ai_endpoint` table. Mirrors LlmFactory: the composition root
 * binds one factory (adapter edge) and consumers (the ai-provider
 * plugin's PlatformDecisions, eval tooling) ask it for concrete
 * DecisionsPort layers per descriptor, never importing adapters.
 * `resolve` fails PortError for non-`systemone` kinds — a generative
 * descriptor is LlmFactory's job, not this port's. `test` is the same
 * liveness ping contract as LlmFactory.test. `presets` carries the
 * adapter's provider starter endpoints (e.g. a hosted System One
 * baseUrl) for the endpoint dialog's preset chips. */
export class DecisionsFactory extends Context.Service<
	DecisionsFactory,
	{
		readonly resolve: (
			descriptor: LlmEndpointDescriptor,
		) => Effect.Effect<Layer.Layer<DecisionsPort>, PortError>;
		readonly test: (descriptor: LlmEndpointDescriptor) => Effect.Effect<void, PortError>;
		readonly presets?: readonly LlmEndpointPreset[];
	}
>()("@ktb/eval-consultation/DecisionsFactory") {}

/**
 * Platform-default DECISION endpoint — the `systemone` sibling of
 * PlatformLlm, bound by the ai-provider plugin's services layer.
 * `defaultLayer` resolves the enabled `scope='platform'` `is_default`
 * endpoint of kind `systemone` through DecisionsFactory on every call,
 * so admin changes apply without a restart; `null` means "no platform
 * decision default configured" and consumers fall back to their own
 * env-derived decision config (e.g. EVAL_SYSTEMONE_URL). Absent service
 * (plugin not registered, or no DecisionsFactory bound) is the same
 * fallback — read it via `Effect.serviceOption`.
 */
export class PlatformDecisions extends Context.Service<
	PlatformDecisions,
	{
		readonly defaultLayer: () => Effect.Effect<Layer.Layer<DecisionsPort> | null, never, unknown>;
	}
>()("@ktb/eval-consultation/PlatformDecisions") {}
