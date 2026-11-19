import { describe, expect, it } from "vitest";

import * as Effect from "effect/Effect";

import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import type { JobRecord } from "@ktb/jobs-port";
import type { CronJobInfo } from "@ktb/server-fns";

import { CronAdmin } from "./admin.ts";
import { cronChromePlugin, cronPanelPlugin, cronServicesPlugin, plugins } from "./index.ts";
import type { CronPageData } from "./platform-page.tsx";

describe("cron plugins", () => {
	it("declares the services contribution behind the admin gate", () => {
		expect(cronServicesPlugin.id).toBe("cron.services");
		expect(cronServicesPlugin.requiredDeps).toEqual(["platform.admin"]);
	});

	it("declares the /platform/cron sidebar entry under Concurrency", () => {
		expect(cronChromePlugin.id).toBe("cron.chrome");
		expect(cronChromePlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(cronChromePlugin.chrome?.[0]).toMatchObject({
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: { to: "/platform/cron", label: "Cronjobs", group: "Concurrency" },
			},
		});
	});

	it("declares the /platform/cron panel page", () => {
		expect(cronPanelPlugin.id).toBe("cron.panel");
		expect(cronPanelPlugin.requiredDeps).toEqual(["platform.panel", "cron.services"]);
		const page = cronPanelPlugin.panel?.pages?.[0];
		expect(page).toMatchObject({ id: "cron.jobs", path: "/platform/cron" });
		expect(typeof page?.guard).toBe("function");
		expect(typeof page?.loader).toBe("function");
	});

	it("is discoverable through the plugins export", () => {
		expect(plugins.map((p) => p.id)).toEqual(["cron.services", "cron.chrome", "cron.panel"]);
	});
});

describe("cron panel page guard", () => {
	const guard = cronPanelPlugin.panel!.pages![0]!.guard as () => Effect.Effect<
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

describe("cron panel page loader", () => {
	const loader = cronPanelPlugin.panel!.pages![0]!.loader as () => Effect.Effect<
		CronPageData,
		never,
		CronAdmin
	>;
	const JOB: CronJobInfo = {
		id: "agenda-reminders",
		schedules: ["*/5 * * * *"],
		description: "Dispatch reminders",
		lastRun: {
			id: "run-1",
			ok: true,
			running: false,
			error: null,
			startedAt: 1700000000000,
			finishedAt: 1700000001000,
		},
	};
	const RUN: JobRecord = {
		id: "run-1",
		kind: "cron.agenda-reminders",
		status: "done",
		payloadRef: null,
		error: null,
		tenantId: null,
		createdAt: 1700000000000,
		updatedAt: 1700000001000,
	};
	const adminStub = (overrides: Partial<CronAdmin["Service"]> = {}) =>
		({
			jobs: () => Effect.succeed([JOB]),
			runs: () => Effect.succeed([RUN]),
			runNow: () => Effect.succeed({ ok: true as const }),
			...overrides,
		}) as unknown as CronAdmin["Service"];

	it("returns both signals", async () => {
		const result = await Effect.runPromise(
			loader().pipe(Effect.provideService(CronAdmin, adminStub())),
		);
		expect(result).toEqual({ jobs: [JOB], runs: [RUN] });
	});

	it("collapses Forbidden sections to null independently", async () => {
		const forbidden = () => Effect.fail(new Forbidden({ path: "platform.admin" }));
		const result = await Effect.runPromise(
			loader().pipe(
				Effect.provideService(CronAdmin, adminStub({ jobs: forbidden, runs: forbidden })),
			),
		);
		expect(result).toEqual({ jobs: null, runs: null });
	});
});
