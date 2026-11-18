# @ktb/eval-adapter-cloud

Cloud adapters for the eval platform: **Workers AI** ASR + LLM/judge
and an **R2-compatible** object store for manifests, blobs and results.

## Capability coverage (T-120)

| Capability          | Cloud adapter       | Status                                            |
| ------------------- | ------------------- | ------------------------------------------------- |
| `transcription.asr` | `makeWorkersAiAsr`  | Implemented — Workers AI REST, PHI-gated          |
| `llm.eval` (llm)    | `makeWorkersAiLlm`  | Implemented — generate + EditList correct         |
| `llm.eval` (eval)   | `makeWorkersAiEval` | Implemented — generative judge, UNCALIBRATED      |
| `storage.dataset`   | `makeR2Store`       | Implemented — samples/blobs/results/manifests     |
| `transcription.tts` | —                   | **NOT AVAILABLE** — Workers AI has no TTS model;  |
|                     |                     | pt-BR voice quality would be poor regardless.     |
|                     |                     | Do not fake it: the `cloud` profile must keep     |
|                     |                     | reporting `tts→transcription.tts` as unsatisfied. |

`makeWorkersAiEval` is a generative stand-in for a decision model —
judge `probability` values are self-reported by the LLM, not
calibrated. For gate-grade judging use a System One endpoint
(`local-systemone` profile); the cloud judge exists so a `--profile
cloud` run can complete end-to-end and still measure a real model.

## Wiring status

The layers below are implemented and tested, but the `cloud` adapter
profile does not select them yet — that requires changes outside this
package: `meta.adapters` entries in `plugins/llm-eval` (`workers-ai`
key → `@ktb/eval-adapter-cloud`), a `cloud` profile row in
`packages/eval-cli/src/resolve.ts`, and layer factories in
`packages/eval-cli/src/adapters.ts` (`EVAL_CF_*` env vars already used
by the ASR path; one `EVAL_LLM_MODEL`-style var pins the chat model).
Until then `eval run --profile cloud` keeps reporting
`llm→llm.eval`, `eval→llm.eval` and `tts→transcription.tts` as
unsatisfied — the diagnostic is honest, not a bug.

## Layers

```ts
makeWorkersAiAsr({
	accountId,
	apiToken,
	model, // e.g. an ASR model alias — required, no hidden default
	readAudio, // (uri) => Effect<Uint8Array, PortError> — you own blob resolution
	readBlobMeta, // optional: (uri) => store.getBlobMeta — stored-provenance lookup
	// endpoint, fetchImpl, timeoutMs, retry are injectable for tests/mocks
});

// LlmPort + EvalPort share WorkersAiLlmOptions — one chat model serves
// both (script_gen/cleanup via makeWorkersAiLlm, judge via
// makeWorkersAiEval). `model` is required: pin the engine you benchmark.
makeWorkersAiLlm({ accountId, apiToken, model /* fetchImpl, … */ });
makeWorkersAiEval({ accountId, apiToken, model /* fetchImpl, … */ });

makeR2Store(bucket); // DatasetStorePort — samples/, blobs/, blobmeta/, results/ prefixes
```

`BucketLike` is the narrow R2 surface (`get`/`put`/`list` with cursor
pagination) — a real `R2Bucket` binding, the REST API, or an in-memory
fake all fit without changes.

## PHI boundary (LGPD)

- **ASR**: audio bytes leave the process for Cloudflare. Voice is PHI —
  `transcribe` refuses non-synthetic audio on TWO channels: the
  caller-declared `origin` AND the provenance stored on the blob
  (`callOpts.blobMeta` from the pipeline, or the `readBlobMeta`
  lookup). Stored `real_anonymized`/`unknown` both refuse unless
  `allowRealAudio: true` is set, and that flag is only for endpoints
  you operate yourself (self-hosted Workers-AI-compatible
  mock/proxy), never the public API. Only verified-`synthetic` blobs
  may leave.
- **Residual bypass (documented)**: an `AudioRef` whose URI has no
  store record — `blobMeta` null/absent — cannot be verified, so the
  adapter falls back to the declared-origin check. `file://` paths
  resolved directly by `readAudio`, or any caller that skips both
  provenance channels, are the operator's responsibility: route audio
  through `putBlob` with `{ origin: "synthetic" }` (or wire
  `readBlobMeta`) before it reaches this adapter.
- **Store**: `putBlob(uri, bytes, meta?)` writes the provenance record
  (`blobmeta/<uri>.json`) BEFORE the bytes, so every stored blob has
  meta — omitting `meta` records `unknown`, which cloud ASR refuses.
  `putSample`/`putResult` re-decode through the Schema
  before writing, so the `real_anonymized` provenance filter
  (`sourcePartner`, `anonymizationMethod`, `consentRef`, `lgpdBasis`)
  fires on write — a non-compliant row can never be persisted.
- **Scripts**: `processSample` re-runs `gateTranscript` on
  `real_anonymized` scripts before any stage and fails closed on
  residual identifiers; downstream stages see the scrubbed text.
