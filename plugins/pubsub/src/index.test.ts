import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { PubSubTopicInfo } from "@ktb/server-fns";

import { PubSubAdmin } from "./admin.ts";
import { plugins, pubsubChromePlugin, pubsubPanelPlugin, pubsubServicesPlugin } from "./index.ts";
import type { PubSubPageData } from "./platform-page.tsx";

describe("pubsub plugins", () => {
	it("declares the services contribution behind the admin gate", () => {
		expect(pubsubServicesPlugin.id).toBe("pubsub.services");
		expect(pubsubServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
	});

	it("declares the /platform/pubsub sidebar entry under Concurrency", () => {
		expect(pubsubChromePlugin.id).toBe("pubsub.chrome");
		expect(pubsubChromePlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(pubsubChromePlugin.chrome?.[0]).toMatchObject({
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/pubsub", label: "Pubsub", group: "Concurrency" },
			},
		});
	});

	it("declares the /platform/pubsub panel page", () => {
		expect(pubsubPanelPlugin.id).toBe("pubsub.panel");
		expect(pubsubPanelPlugin.requiredDeps).toEqual(["platform.panel", "pubsub.services"]);
		const page = pubsubPanelPlugin.panel?.pages?.[0];
		expect(page).toMatchObject({ id: "pubsub.topics", path: "/platform/pubsub" });
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("is discoverable through the plugins export", () => {
		expect(plugins.map((p) => p.id)).toEqual(["pubsub.services", "pubsub.chrome", "pubsub.panel"]);
	});
});

describe("pubsub panel page guard", () => {
	const guard = pubsubPanelPlugin.panel!.pages![0]!.guard as () => Effect.Effect<
		boolean,
		never,
		PlatformAdmin
	>;
	const gate = (admin: boolean) =>
		makePlatformAdminGate(parsePlatformAdminEmails(admin ? "admin@x.com" : ""));

	it("returns true for allowlisted admins", async () => {
		const result = await Effect.runPromise(
			guard().pipe(
				Effect.provideService(PlatformAdmin, gate(true)),
				Effect.provideService(Principal, {
					userId: "u1",
					email: "admin@x.com",
				}),
			),
		);
		expect(result).toBe(true);
	});

	it("returns false for non-admins and null principals", async () => {
		for (const principal of [{ userId: "u1", email: "doc@x.com" }, null] as const) {
			const result = await Effect.runPromise(
				guard().pipe(
					Effect.provideService(PlatformAdmin, gate(true)),
					Effect.provideService(Principal, principal),
				),
			);
			expect(result).toBe(false);
		}
	});
});

describe("pubsub panel page loader", () => {
	const loader = pubsubPanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
		PubSubPageData,
		never,
		PubSubAdmin
	>;
	const TOPIC: PubSubTopicInfo = {
		id: "memory:cron.fires",
		name: "cron.fires",
		transport: "in-process",
		subscribers: 1,
		recent: [{ at: 1700000000000, payload: { jobId: "agenda-reminders", ok: true } }],
	};
	const adminStub = (overrides: Partial<PubSubAdmin["Service"]> = {}) =>
		({
			topics: () => Effect.succeed([TOPIC]),
			publish: () => Effect.succeed({ ok: true as const }),
			...overrides,
		}) as unknown as PubSubAdmin["Service"];

	it("returns the topics signal", async () => {
		const result = await Effect.runPromise(
			loader().pipe(Effect.provideService(PubSubAdmin, adminStub())),
		);
		expect(result).toEqual({ topics: [TOPIC] });
	});

	it("collapses Forbidden to null", async () => {
		const forbidden = () => Effect.fail(new Forbidden({ path: "platform.admin" }));
		const result = await Effect.runPromise(
			loader().pipe(Effect.provideService(PubSubAdmin, adminStub({ topics: forbidden }))),
		);
		expect(result).toEqual({ topics: null });
	});
});
