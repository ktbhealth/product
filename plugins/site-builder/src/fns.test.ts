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

import { Layouts } from "@ktb/layouts/service";
import { Pages } from "@ktb/pages/service";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { parseBuilderDoc } from "@ktb/builder";

import { builderDocumentFn, saveBuilderDocumentFn } from "./fns.ts";

const pageRow = {
	id: 7,
	path: "/about",
	title: "About",
	richTextId: null,
	searchSchemaId: null,
	layoutId: null,
	builderJson: '{"version":1,"data":{"content":[]}}',
	published: true,
	showInNav: false,
	sortOrder: 0,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const layoutDoc = {
	id: 3,
	name: "Landing",
	description: "Landing body",
	sectionCount: 2,
	createdAt: new Date(0),
	updatedAt: new Date(0),
	config: '{"sections":[]}',
	builderJson: null,
};

/** Captures the last adminSetBuilderJson payload per kind. */
const saved: { page?: string | null; layout?: string | null } = {};

const pagesStub = {
	adminGet: () => Effect.succeed(pageRow),
	adminSetBuilderJson: (_id: number, builderJson: string | null) => {
		saved.page = builderJson;
		return Effect.succeed(pageRow);
	},
};
const layoutsStub = {
	adminGet: () => Effect.succeed(layoutDoc),
	adminSetBuilderJson: (_id: number, builderJson: string | null) => {
		saved.layout = builderJson;
		return Effect.succeed(layoutDoc);
	},
};

describe("site-builder fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	const auth = stubAuth(() => sessionUser(currentEmail));

	beforeAll(() => {
		runtime = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(Pages, pagesStub as never),
				Layer.succeed(Layouts, layoutsStub as never),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(runtime, auth);
	});

	afterAll(() => {
		resetServerFnRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(builderDocumentFn({ data: { kind: "page", id: 7 } })).rejects.toThrow(
			"unauthenticated",
		);
		await expect(
			saveBuilderDocumentFn({ data: { kind: "page", id: 7, builderJson: "{}" } }),
		).rejects.toThrow("unauthenticated");
	});

	it("collapses handled failures to null/false for non-admins", async () => {
		currentEmail = "doc@x.com";
		await expect(builderDocumentFn({ data: { kind: "page", id: 7 } })).resolves.toBeNull();
		await expect(builderDocumentFn({ data: { kind: "layout", id: 3 } })).resolves.toBeNull();
		await expect(
			saveBuilderDocumentFn({ data: { kind: "page", id: 7, builderJson: "{}" } }),
		).resolves.toBe(false);
	});

	it("loads page and layout documents as admin", async () => {
		currentEmail = "admin@x.com";
		await expect(builderDocumentFn({ data: { kind: "page", id: 7 } })).resolves.toEqual({
			kind: "page",
			id: 7,
			title: "About",
			subtitle: "/about",
			builderJson: pageRow.builderJson,
		});
		await expect(builderDocumentFn({ data: { kind: "layout", id: 3 } })).resolves.toEqual({
			kind: "layout",
			id: 3,
			title: "Landing",
			subtitle: "Landing body",
			builderJson: null,
		});
	});

	it("returns null when the row is missing", async () => {
		currentEmail = "admin@x.com";
		const missingPages = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(Pages, { adminGet: () => Effect.succeed(null) } as never),
				Layer.succeed(Layouts, layoutsStub as never),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(missingPages, auth);
		try {
			await expect(builderDocumentFn({ data: { kind: "page", id: 99 } })).resolves.toBeNull();
		} finally {
			installServerFnRuntime(runtime, auth);
			await missingPages.dispose();
		}
	});

	it("rejects malformed builderJson without touching the service", async () => {
		currentEmail = "admin@x.com";
		saved.page = undefined;
		await expect(
			saveBuilderDocumentFn({ data: { kind: "page", id: 7, builderJson: "{oops" } }),
		).resolves.toBe(false);
		expect(saved.page).toBeUndefined();
		await expect(
			saveBuilderDocumentFn({ data: { kind: "page", id: 7, builderJson: "[1]" } }),
		).resolves.toBe(false);
		expect(saved.page).toBeUndefined();
	});

	it("saves a canonical versioned document for pages and layouts", async () => {
		currentEmail = "admin@x.com";
		const payload = JSON.stringify({
			version: 1,
			data: { root: { props: {} }, content: [{ type: "heading", props: { id: "h" } }], zones: {} },
		});
		await expect(
			saveBuilderDocumentFn({ data: { kind: "page", id: 7, builderJson: payload } }),
		).resolves.toBe(true);
		const storedPage = parseBuilderDoc(saved.page ?? null);
		expect(storedPage?.version).toBe(1);
		expect((storedPage?.data as { content?: unknown[] }).content).toHaveLength(1);

		await expect(
			saveBuilderDocumentFn({ data: { kind: "layout", id: 3, builderJson: payload } }),
		).resolves.toBe(true);
		expect(parseBuilderDoc(saved.layout ?? null)?.version).toBe(1);
	});

	it("collapses service InvalidBuilderDoc failures to false", async () => {
		currentEmail = "admin@x.com";
		const failing = ManagedRuntime.make(
			Layer.mergeAll(
				Layer.succeed(
					PlatformAdmin,
					makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com")),
				),
				Layer.succeed(Pages, {
					adminSetBuilderJson: () => Effect.fail({ _tag: "InvalidBuilderDoc", builderJson: "x" }),
				} as never),
				Layer.succeed(Layouts, layoutsStub as never),
			) as Layer.Layer<unknown, never, never>,
		);
		installServerFnRuntime(failing, auth);
		try {
			await expect(
				saveBuilderDocumentFn({
					data: { kind: "page", id: 7, builderJson: '{"version":1,"data":{}}' },
				}),
			).resolves.toBe(false);
		} finally {
			installServerFnRuntime(runtime, auth);
			await failing.dispose();
		}
	});
});
