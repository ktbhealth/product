import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	user: { current: null as null | { id: string; email: string; name: string } },
	admin: {
		namespaces: vi.fn<I18nAdminShape["namespaces"]>(),
		locales: vi.fn<I18nAdminShape["locales"]>(),
		messages: vi.fn<I18nAdminShape["messages"]>(),
		saveDraft: vi.fn<I18nAdminShape["saveDraft"]>(),
		publish: vi.fn<I18nAdminShape["publish"]>(),
		discardDraft: vi.fn<I18nAdminShape["discardDraft"]>(),
		setLocaleEnabled: vi.fn<I18nAdminShape["setLocaleEnabled"]>(),
		exportNamespace: vi.fn<I18nAdminShape["exportNamespace"]>(),
		importNamespace: vi.fn<I18nAdminShape["importNamespace"]>(),
	},
}));

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => new Headers(),
}));
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

// @ktb/auth is not a direct dep of this plugin — stub the session/runAs
// ports instead of composing the real server runtime.
vi.mock("@ktb/server-fns", () => ({
	getSessionUser: async () => h.user.current,
	runAs: async (_user: unknown, effect: unknown) => {
		const EffectNS = await import("effect/Effect");
		const { I18nAdmin } = await import("./contract.ts");
		return EffectNS.runPromise(
			(effect as import("effect/Effect").Effect<unknown, unknown, never>).pipe(
				EffectNS.provideService(I18nAdmin, h.admin as never),
			),
		);
	},
}));

import { Forbidden } from "@ktb/authz";
import * as Effect from "effect/Effect";

import { I18nValidationError, type I18nAdminShape } from "./contract.ts";
import {
	i18nDiscardDraftFn,
	i18nExportFn,
	i18nImportFn,
	i18nNamespaceMessagesFn,
	i18nPublishFn,
	i18nSaveDraftFn,
	i18nSetLocaleFn,
} from "./fns.ts";

const ok = <A>(value: A) => Effect.succeed(value);
const denied = () => Effect.fail(new Forbidden({ path: "i18n.messages.read" }));

const ID = { namespace: "app", key: "title", locale: "en" };

beforeEach(() => {
	h.user.current = { id: "u1", email: "admin@x.com", name: "Admin" };
	h.admin.namespaces.mockReset().mockImplementation(() => ok([]));
	h.admin.locales.mockReset().mockImplementation(() => ok([]));
	h.admin.messages.mockReset().mockImplementation(() => ok([]));
	h.admin.saveDraft.mockReset().mockImplementation(() => ok(undefined));
	h.admin.publish.mockReset().mockImplementation(() => ok(undefined));
	h.admin.discardDraft.mockReset().mockImplementation(() => ok(undefined));
	h.admin.setLocaleEnabled.mockReset().mockImplementation(() => ok(undefined));
	h.admin.exportNamespace
		.mockReset()
		.mockImplementation((ns) => ok({ version: 1 as const, namespace: ns, messages: {} } as never));
	h.admin.importNamespace.mockReset().mockImplementation(() => ok({ imported: 3 }));
});

afterEach(() => {
	h.user.current = null;
	vi.restoreAllMocks();
});

describe("i18n fns", () => {
	it("returns null for anonymous callers", async () => {
		h.user.current = null;
		await expect(i18nNamespaceMessagesFn({ data: { namespace: "app" } })).resolves.toBeNull();
	});

	it("collapses Forbidden from fns without their own catch to ok:false", async () => {
		h.admin.messages.mockReturnValueOnce(denied());
		await expect(i18nNamespaceMessagesFn({ data: { namespace: "app" } })).resolves.toEqual({
			ok: false,
		});
	});

	it("tolerates a missing validator payload", async () => {
		// `input ?? {}` still fails schema decode — namespace is required.
		await expect(i18nNamespaceMessagesFn({ data: null })).rejects.toThrow("Missing key");
	});

	it("rejects an empty namespace — no unfiltered dump", async () => {
		await expect(i18nNamespaceMessagesFn({ data: { namespace: "" } })).rejects.toThrow(
			"length of at least 1",
		);
		expect(h.admin.messages).not.toHaveBeenCalled();
	});

	it("caps namespace message rows at 10k", async () => {
		const rows = Array.from({ length: 10_001 }, (_, i) => ({ key: `k${i}` }));
		h.admin.messages.mockReturnValue(ok(rows as never));
		const res = (await i18nNamespaceMessagesFn({ data: { namespace: "app" } })) as unknown[];
		expect(res).toHaveLength(10_000);
	});

	it("non-authorization failures propagate instead of collapsing to ok:false", async () => {
		h.admin.messages.mockReturnValue(Effect.fail(new Error("db down")) as never);
		await expect(i18nNamespaceMessagesFn({ data: { namespace: "app" } })).rejects.toThrow(
			"db down",
		);
	});

	it("fetches namespace messages with scope filter", async () => {
		const rows = [{ namespace: "app" }];
		h.admin.messages.mockReturnValue(ok(rows as never));
		await expect(
			i18nNamespaceMessagesFn({ data: { namespace: "app", scope: "tenant", scopeId: "t1" } }),
		).resolves.toEqual(rows);
		expect(h.admin.messages).toHaveBeenCalledWith({
			namespace: "app",
			scope: "tenant",
			scopeId: "t1",
		});
	});

	it("saves drafts and reports validation + forbidden as ok:false", async () => {
		await expect(i18nSaveDraftFn({ data: { ...ID, value: "Hello {name}" } })).resolves.toEqual({
			ok: true,
		});
		h.admin.saveDraft
			.mockReturnValueOnce(Effect.fail(new I18nValidationError({ error: "bad template" })))
			.mockReturnValueOnce(denied());
		await expect(i18nSaveDraftFn({ data: { ...ID, value: "x" } })).resolves.toEqual({
			ok: false,
			error: "bad template",
		});
		await expect(i18nSaveDraftFn({ data: { ...ID, value: "x" } })).resolves.toEqual({
			ok: false,
		});
	});

	it("rejects draft values over the length cap at the validator", async () => {
		await expect(i18nSaveDraftFn({ data: { ...ID, value: "x".repeat(50_001) } })).rejects.toThrow(
			/at most/,
		);
	});

	it("publishes and discards drafts", async () => {
		await expect(i18nPublishFn({ data: ID })).resolves.toEqual({ ok: true });
		await expect(
			i18nDiscardDraftFn({ data: { ...ID, scope: "portal", scopeId: "p1" } }),
		).resolves.toEqual({ ok: true });
		h.admin.publish.mockReturnValueOnce(denied());
		await expect(i18nPublishFn({ data: ID })).resolves.toEqual({ ok: false });
		h.admin.discardDraft.mockReturnValueOnce(denied());
		await expect(i18nDiscardDraftFn({ data: ID })).resolves.toEqual({ ok: false });
	});

	it("maps publish + locale validation errors to ok:false with the message", async () => {
		h.admin.publish.mockReturnValueOnce(
			Effect.fail(new I18nValidationError({ error: "bad draft" })),
		);
		await expect(i18nPublishFn({ data: ID })).resolves.toEqual({
			ok: false,
			error: "bad draft",
		});
		h.admin.setLocaleEnabled.mockReturnValueOnce(
			Effect.fail(new I18nValidationError({ error: "unknown locale 'zz'" })),
		);
		await expect(i18nSetLocaleFn({ data: { code: "zz", enabled: true } })).resolves.toEqual({
			ok: false,
			error: "unknown locale 'zz'",
		});
	});

	it("exports a namespace", async () => {
		await expect(i18nExportFn({ data: "app" })).resolves.toEqual({
			version: 1,
			namespace: "app",
			messages: {},
		});
	});

	it("imports within limits and returns the imported count", async () => {
		const payload = {
			version: 1,
			namespace: "app",
			messages: { en: { title: "Hi" } },
		};
		h.admin.importNamespace.mockReturnValue(ok({ imported: 7 }));
		await expect(i18nImportFn({ data: payload })).resolves.toEqual({ ok: true, imported: 7 });
		expect(h.admin.importNamespace).toHaveBeenCalledWith(payload);
	});

	it("rejects oversized import payloads before the service", async () => {
		const big = {
			messages: {
				en: Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`k${i}`, "v"])),
			},
		};
		await expect(i18nImportFn({ data: big })).resolves.toEqual({
			ok: false,
			error: "import payload too large",
		});
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		await expect(i18nImportFn({ data: circular })).resolves.toEqual({
			ok: false,
			error: "import payload too large",
		});
		const huge = "x".repeat(1_000_001);
		await expect(i18nImportFn({ data: { messages: { en: { big: huge } } } })).resolves.toEqual({
			ok: false,
			error: "import payload too large",
		});
		expect(h.admin.importNamespace).not.toHaveBeenCalled();
		// Non-object payloads pass the size gate — shape validation is
		// the service's job. Non-object locale maps are skipped by the
		// entry counter the same way.
		await expect(i18nImportFn({ data: 42 })).resolves.toEqual({ ok: true, imported: 3 });
		await expect(
			i18nImportFn({ data: { namespace: "app", messages: { en: "nope", "pt-BR": null } } }),
		).resolves.toEqual({ ok: true, imported: 3 });
	});

	it("maps import validation and forbidden failures to ok:false", async () => {
		h.admin.importNamespace
			.mockReturnValueOnce(
				Effect.fail(new I18nValidationError({ error: "invalid export payload" })),
			)
			.mockReturnValueOnce(denied());
		await expect(i18nImportFn({ data: { namespace: "app" } })).resolves.toEqual({
			ok: false,
			error: "invalid export payload",
		});
		await expect(i18nImportFn({ data: { namespace: "app" } })).resolves.toEqual({ ok: false });
	});

	it("toggles locale enablement", async () => {
		await expect(i18nSetLocaleFn({ data: { code: "fr", enabled: true } })).resolves.toEqual({
			ok: true,
		});
		expect(h.admin.setLocaleEnabled).toHaveBeenCalledWith("fr", true);
		h.admin.setLocaleEnabled.mockReturnValueOnce(denied());
		await expect(i18nSetLocaleFn({ data: { code: "fr", enabled: false } })).resolves.toEqual({
			ok: false,
		});
	});
});
