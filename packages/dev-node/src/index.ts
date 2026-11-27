/**
 * Node-only dev/runtime stand-ins for the Cloudflare bindings that have
 * no workerd equivalent under `KTB_DEV_NODE=1` (`bun run dev:node`).
 * Consumed exclusively by apps/web's node-cloudflare-workers.ts shim —
 * this package is never bundled for workerd.
 */

export { makeLocalAudioBucket } from "./audio-bucket.ts";
export { loadDevVars, parseDevVars } from "./dev-vars.ts";
export { makeLocalQueue } from "./queue.ts";
export type {
	LocalQueue,
	LocalQueueHandler,
	LocalQueueMessage,
	LocalQueueOptions,
} from "./queue.ts";
