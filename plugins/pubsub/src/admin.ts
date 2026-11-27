import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Forbidden } from "@ktb/authz";
import { PlatformAdmin } from "@ktb/platform";
import {
	runtimeProbe,
	type EventTopicInfo,
	type PubSubPublishResult,
	type PubSubTopicsResult,
} from "@ktb/server-fns";

/**
 * Pub/sub console port: the read/publish side of /platform/pubsub.
 *
 * - `topics`: every topic the bound transports enumerate — the
 *   in-process bus's known topics plus Redis PUBSUB CHANNELS when the
 *   deployment binds it — plus the ids of sources whose probe failed
 *   (`degraded`), so a bound-but-down transport renders honestly.
 *   Null when the runtime cannot report at all.
 * - `publish`: route a JSON payload to a topic by its console-facing
 *   id (`memory:<name>` / `redis:<channel>`). Honest result reasons —
 *   never a thrown wire error for expected cases.
 *
 * Every method re-checks PlatformAdmin — defense in depth on top of
 * the page guard, same contract as plugins/queue and plugins/cron.
 */
export type { PubSubPublishResult } from "@ktb/server-fns";

export class PubSubAdmin extends Context.Service<
	PubSubAdmin,
	{
		readonly topics: () => Effect.Effect<PubSubTopicsResult | null, Forbidden>;
		/** `events.topic` plugin declarations — the topic catalog,
		 * independent of live transport enumeration. Null when the
		 * capability is absent. */
		readonly declaredTopics: () => Effect.Effect<readonly EventTopicInfo[] | null, Forbidden>;
		readonly publish: (
			topicId: string,
			payload: unknown,
		) => Effect.Effect<PubSubPublishResult, Forbidden>;
	}
>()("@ktb/pubsub/PubSubAdmin") {}

export const PubSubAdminLive = Layer.effect(
	PubSubAdmin,
	Effect.gen(function* () {
		const platformAdmin = yield* PlatformAdmin;
		return PubSubAdmin.of({
			topics: () =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<PubSubTopicsResult | null> => {
							try {
								const capability = runtimeProbe((r) => r.pubsub);
								return capability === undefined ? null : await capability.topics();
							} catch {
								return null;
							}
						}),
					),
				),
			declaredTopics: () =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<readonly EventTopicInfo[] | null> => {
							try {
								const read = runtimeProbe((r) => r.pubsub?.declaredTopics);
								return read === undefined ? null : read();
							} catch {
								return null;
							}
						}),
					),
				),
			publish: (topicId, payload) =>
				platformAdmin.requireAdmin().pipe(
					Effect.andThen(
						Effect.promise(async (): Promise<PubSubPublishResult> => {
							const capability = runtimeProbe((r) => r.pubsub);
							if (capability === undefined) return { ok: false, reason: "unavailable" };
							try {
								return await capability.publish(topicId, payload);
							} catch {
								return { ok: false, reason: "publish-failed" };
							}
						}),
					),
				),
		});
	}),
);
