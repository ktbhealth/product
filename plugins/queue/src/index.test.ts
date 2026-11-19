import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { JobRecord } from "@ktb/jobs-port";
import type { QueueInfo } from "@ktb/server-fns";

import { knownJobKinds, QueueAdmin } from "./admin.ts";
import { queueChromePlugin, queuePanelPlugin, queueServicesPlugin, plugins } from "./index.ts";
import type { QueuePageData } from "./platform-page.tsx";

describe("queue plugins", () => {
	it("declares the services contribution behind the admin gate", () => {
		expect(queueServicesPlugin.id).toBe("queue.services");
		expect(queueServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
	});

	it("declares the /platform/queue sidebar entry under Concurrency", () => {
		expect(queueChromePlugin.id).toBe("queue.chrome");
		expect(queueChromePlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(queueChromePlugin.chrome?.[0]).toMatchObject({
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/queue", label: "Queue", group: "Concurrency" },
			},
		});
	});

	it("declares the /platform/queue panel page", () => {
		expect(queuePanelPlugin.id).toBe("queue.panel");
		expect(queuePanelPlugin.requiredDeps).toEqual(["platform.panel", "queue.services"]);
		const page = queuePanelPlugin.panel?.pages?.[0];
		expect(page).toMatchObject({ id: "queue.jobs", path: "/platform/queue" });
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("is discoverable through the plugins export", () => {
		expect(plugins.map((p) => p.id)).toEqual(["queue.services", "queue.chrome", "queue.panel"]);
	});
});

describe("queue panel page guard", () => {
	const guard = queuePanelPlugin.panel!.pages![0]!.guard as () => Effect.Effect<
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

describe("queue panel page loader", () => {
	const loader = queuePanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
		QueuePageData,
		never,
		QueueAdmin
	>;
	const QUEUE: QueueInfo = {
		id: "jobs",
		name: "ktb:jobs",
		transport: "redis",
		consumer: "jobs-worker",
		depth: { pending: 2, processing: 0, done: 9, failed: 1 },
	};
	const RUN: JobRecord = {
		id: "run-1",
		kind: "jobs.ping",
		status: "done",
		payloadRef: null,
		error: null,
		tenantId: null,
		createdAt: 1700000000000,
		updatedAt: 1700000001000,
	};
	const adminStub = (overrides: Partial<QueueAdmin["Service"]> = {}) =>
		({
			queues: () => Effect.succeed([QUEUE]),
			jobRuns: () => Effect.succeed([RUN]),
			kinds: () => Effect.succeed(["jobs.ping"]),
			enqueue: () => Effect.succeed({ ok: true as const }),
			...overrides,
		}) as unknown as QueueAdmin["Service"];

	it("returns all three signals", async () => {
		const result = await Effect.runPromise(
			loader().pipe(Effect.provideService(QueueAdmin, adminStub())),
		);
		expect(result).toEqual({ queues: [QUEUE], runs: [RUN], kinds: ["jobs.ping"] });
	});

	it("collapses Forbidden sections to null independently", async () => {
		const forbidden = () => Effect.fail(new Forbidden({ path: "platform.admin" }));
		const result = await Effect.runPromise(
			loader().pipe(
				Effect.provideService(QueueAdmin, adminStub({ queues: forbidden, jobRuns: forbidden })),
			),
		);
		expect(result).toEqual({ queues: null, runs: null, kinds: ["jobs.ping"] });
	});
});

describe("knownJobKinds", () => {
	it("always includes the built-in ping kind", () => {
		expect(knownJobKinds()).toContain("jobs.ping");
	});
});
