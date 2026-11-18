import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Json } from "effect/Schema";
import * as ManagedRuntime from "effect/ManagedRuntime";

import type { WizardDefinition } from "./definition.ts";
import { WizardDefinitions } from "./definition.ts";
import {
	abandonWizardFn,
	advanceWizardFn,
	adminDeleteWizardDefFn,
	adminListWizardDefsFn,
	adminSaveWizardDefFn,
	adminSetWizardPublishedFn,
	backWizardFn,
	completeWizardFn,
	defFromWire,
	getWizardRunFn,
	runViewFromWire,
	startWizardFn,
	wizardDefsFn,
} from "./fns.ts";
import { WIZARDS_TEST_DDL, Wizards, WizardsServicesLive } from "./service.ts";

const DEF: WizardDefinition = {
	id: "intake",
	title: "Intake",
	steps: [
		{ kind: "info", id: "welcome" },
		{ kind: "form", id: "details", schema: { type: "object" } },
	],
};

describe("wizards fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	const installRuntime = (rt: ManagedRuntime.ManagedRuntime<unknown, never>) =>
		installServerFnRuntime(rt, auth);

	beforeAll(() => {
		const db = makeDb(makeD1(WIZARDS_TEST_DDL));
		const env = Layer.mergeAll(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
			Layer.succeed(WizardDefinitions, { wizards: [DEF] }),
		);
		// env stays ambient too: the admin fns yield PlatformAdmin per
		// call (defense-in-depth gate inside runAs).
		runtime = ManagedRuntime.make(
			Layer.mergeAll(WizardsServicesLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		installRuntime(runtime);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("serves the public defs listing without a session", async () => {
		currentEmail = null;
		await expect(wizardDefsFn()).resolves.toEqual([]);
	});

	it("returns [] from the public listing when the service is absent", async () => {
		const rt = ManagedRuntime.make(Layer.empty as Layer.Layer<unknown>);
		installRuntime(rt);
		try {
			await expect(wizardDefsFn()).resolves.toEqual([]);
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});

	it("rejects anonymous session-gated calls", async () => {
		await expect(startWizardFn({ data: { key: "intake", definition: DEF } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(getWizardRunFn({ data: { runId: 1 } })).rejects.toThrow("unauthenticated");
		await expect(advanceWizardFn({ data: { runId: 1 } })).rejects.toThrow("unauthenticated");
		await expect(backWizardFn({ data: { runId: 1 } })).rejects.toThrow("unauthenticated");
		await expect(abandonWizardFn({ data: { runId: 1 } })).rejects.toThrow("unauthenticated");
		await expect(completeWizardFn({ data: { runId: 1 } })).rejects.toThrow("unauthenticated");
		await expect(adminListWizardDefsFn()).rejects.toThrow("unauthenticated");
	});

	it("denies non-admin principals on admin fns", async () => {
		currentEmail = "doc@x.com";
		await expect(adminListWizardDefsFn()).resolves.toEqual([]);
		await expect(
			adminSaveWizardDefFn({ data: { key: "x", title: "x", definition: DEF } }),
		).resolves.toBeNull();
		await expect(adminSetWizardPublishedFn({ data: { key: "x", published: true } })).resolves.toBe(
			false,
		);
		await expect(adminDeleteWizardDefFn({ data: { key: "x" } })).resolves.toBe(false);
	});

	it("validates wire input before the handler runs", async () => {
		currentEmail = "admin@x.com";
		await expect(startWizardFn({ data: { key: 1 } } as never)).rejects.toBeInstanceOf(Error);
		await expect(getWizardRunFn({ data: { runId: "1" } } as never)).rejects.toBeInstanceOf(Error);
		await expect(advanceWizardFn({ data: {} } as never)).rejects.toBeInstanceOf(Error);
		await expect(adminSaveWizardDefFn({ data: { key: "x" } } as never)).rejects.toBeInstanceOf(
			Error,
		);
		await expect(adminSetWizardPublishedFn({ data: { key: "x" } } as never)).rejects.toBeInstanceOf(
			Error,
		);
		await expect(adminDeleteWizardDefFn({ data: {} } as never)).rejects.toBeInstanceOf(Error);
	});

	it("runs the full lifecycle as a regular user", async () => {
		currentEmail = "u@x.com";
		const started = await startWizardFn({
			data: { key: "intake", definition: DEF },
		});
		expect(started).not.toBeNull();
		expect(started?.status).toBe("active");
		expect(started?.step).toMatchObject({ id: "welcome" });
		expect(started?.definition).toMatchObject({ id: "intake" });

		const runId = started!.id;
		const fetched = await getWizardRunFn({ data: { runId } });
		expect(fetched?.id).toBe(runId);

		const second = await advanceWizardFn({ data: { runId, stepId: "welcome" } });
		expect(second?.step).toMatchObject({ id: "details" });
		expect(second?.canGoBack).toBe(true);

		// step mismatch → handled → null
		await expect(
			advanceWizardFn({ data: { runId, stepId: "bogus", value: {} } }),
		).resolves.toBeNull();

		const done = await advanceWizardFn({
			data: { runId, stepId: "details", value: { name: "Ana" } },
		});
		expect(done?.status).toBe("completed");

		// terminal run → handled → null
		await expect(getWizardRunFn({ data: { runId: 999999 } })).resolves.toBeNull();
		await expect(advanceWizardFn({ data: { runId, stepId: "details" } })).resolves.toBeNull();
	});

	it("backs up and abandons runs", async () => {
		currentEmail = "u2@x.com";
		const started = await startWizardFn({
			data: { key: "intake", definition: DEF },
		});
		const runId = started!.id;
		await advanceWizardFn({ data: { runId, stepId: "welcome" } });
		const backed = await backWizardFn({ data: { runId } });
		expect(backed?.step).toMatchObject({ id: "welcome" });

		await expect(abandonWizardFn({ data: { runId } })).resolves.toBe(true);
		// already terminal → handled → false
		await expect(abandonWizardFn({ data: { runId } })).resolves.toBe(false);
		await expect(completeWizardFn({ data: { runId } })).resolves.toBeNull();
	});

	it("admin CRUD over definitions end-to-end", async () => {
		currentEmail = "admin@x.com";
		const saved = await adminSaveWizardDefFn({
			data: { key: "intake", title: "Intake", definition: DEF as unknown as Json, published: true },
		});
		expect(saved).toMatchObject({ key: "intake", title: "Intake", published: true });
		expect(saved?.updatedAt).toMatch(/T.*Z/);

		// id mismatch → handled → null
		await expect(
			adminSaveWizardDefFn({
				data: { key: "other", title: "x", definition: DEF },
			}),
		).resolves.toBeNull();

		await expect(
			adminSetWizardPublishedFn({ data: { key: "intake", published: false } }),
		).resolves.toBe(true);
		// public listing now excludes the draft
		await expect(wizardDefsFn()).resolves.toEqual([]);
		await expect(
			adminSetWizardPublishedFn({ data: { key: "ghost", published: true } }),
		).resolves.toBe(false);

		const all = await adminListWizardDefsFn();
		expect(all.map((d) => d.key)).toEqual(["intake"]);

		await expect(adminDeleteWizardDefFn({ data: { key: "intake" } })).resolves.toBe(true);
		await expect(adminDeleteWizardDefFn({ data: { key: "intake" } })).resolves.toBe(false);
	});

	it("starts a run against a published DB def without a client payload", async () => {
		currentEmail = "admin@x.com";
		await adminSaveWizardDefFn({
			data: { key: "dbdef", title: "DB", definition: { ...DEF, id: "dbdef" }, published: true },
		});
		currentEmail = "u3@x.com";
		const started = await startWizardFn({ data: { key: "dbdef" } });
		expect(started?.definition).toMatchObject({ id: "dbdef" });
		// unpublished DB def → handled → null
		currentEmail = "admin@x.com";
		await adminSaveWizardDefFn({
			data: { key: "draft", title: "D", definition: { ...DEF, id: "draft" } },
		});
		currentEmail = "u3@x.com";
		await expect(startWizardFn({ data: { key: "draft", definition: DEF } })).resolves.toBeNull();
		currentEmail = "admin@x.com";
		await adminDeleteWizardDefFn({ data: { key: "dbdef" } });
		await adminDeleteWizardDefFn({ data: { key: "draft" } });
	});

	it("propagates unexpected service errors instead of mapping them", async () => {
		const stub = Wizards.of({
			publishedDefs: () => Effect.succeed([]),
			adminList: () => Effect.fail({ _tag: "Other" }),
			adminUpsert: () => Effect.fail({ _tag: "Other" }),
			adminSetPublished: () => Effect.fail({ _tag: "Other" }),
			adminRemove: () => Effect.fail({ _tag: "Other" }),
			startRun: () => Effect.fail({ _tag: "Other" }),
			getRun: () => Effect.fail({ _tag: "Other" }),
			advance: () => Effect.fail({ _tag: "Other" }),
			back: () => Effect.fail({ _tag: "Other" }),
			abandon: () => Effect.fail({ _tag: "Other" }),
			complete: () => Effect.fail({ _tag: "Other" }),
		} as unknown as Wizards["Service"]);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(Wizards, stub),
			) as Layer.Layer<unknown, never, never>,
		);
		installRuntime(rt);
		currentEmail = "admin@x.com";
		try {
			await expect(adminListWizardDefsFn()).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				adminSaveWizardDefFn({ data: { key: "x", title: "x", definition: {} } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(
				adminSetWizardPublishedFn({ data: { key: "x", published: true } }),
			).rejects.toMatchObject({ _tag: "Other" });
			await expect(adminDeleteWizardDefFn({ data: { key: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			currentEmail = "u@x.com";
			await expect(startWizardFn({ data: { key: "x" } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(getWizardRunFn({ data: { runId: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(advanceWizardFn({ data: { runId: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(backWizardFn({ data: { runId: 1 } })).rejects.toMatchObject({ _tag: "Other" });
			await expect(abandonWizardFn({ data: { runId: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
			await expect(completeWizardFn({ data: { runId: 1 } })).rejects.toMatchObject({
				_tag: "Other",
			});
		} finally {
			installRuntime(runtime);
			await rt.dispose();
		}
	});
});

describe("wire helpers", () => {
	it("defFromWire validates and runViewFromWire narrows", () => {
		expect(defFromWire(null)).toBeNull();
		expect(defFromWire(undefined)).toBeNull();
		expect(
			defFromWire({
				key: "k",
				title: "",
				description: "",
				definition: { id: "Bad Id", steps: [] },
				published: true,
				updatedAt: "",
			}),
		).toBeNull();
		expect(
			defFromWire({
				key: "k",
				title: "T",
				description: "",
				definition: DEF as unknown as Json,
				published: true,
				updatedAt: "",
			})?.id,
		).toBe("intake");

		expect(runViewFromWire(null)).toBeNull();
		expect(
			runViewFromWire({
				id: 1,
				key: "k",
				status: "active",
				definition: { nope: true },
				step: null,
				stepIndex: 0,
				canGoBack: false,
				isLastStep: false,
				answers: {},
			}),
		).toBeNull();
		const view = runViewFromWire({
			id: 1,
			key: "intake",
			status: "active",
			definition: DEF as unknown as Json,
			step: { kind: "info", id: "welcome" },
			stepIndex: 0,
			canGoBack: false,
			isLastStep: false,
			answers: {},
		});
		expect(view?.step?.id).toBe("welcome");
		expect(view?.definition.id).toBe("intake");
	});
});
