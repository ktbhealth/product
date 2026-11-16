import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };
const cookie = {
	value: null as string | null,
	getThrows: false,
	setThrows: false,
	set: [] as unknown[][],
	del: [] as unknown[][],
};

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

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => headers.current,
	getCookie: () => {
		if (cookie.getThrows) throw new Error("cookie read failed");
		return cookie.value;
	},
	setCookie: (...args: unknown[]) => {
		if (cookie.setThrows) throw new Error("cookie write failed");
		cookie.set.push(args);
	},
	deleteCookie: (...args: unknown[]) => {
		cookie.del.push(args);
	},
}));

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Forbidden, Principal } from "@ktb/authz";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { resetServerRuntime, setServerRuntime } from "@ktb/server-fns";

import { KTB_DEFAULT_THEME } from "./default-theme.ts";
import {
	getThemeFn,
	listThemesFn,
	publishThemeFn,
	setThemeEnabledFn,
	setThemePreviewFn,
	themeScopeFn,
} from "./fns.ts";
import { presentTheme, type ThemeDefinitionRow } from "./present.ts";
import { Theme, type ThemePublishInput, type ThemeRow } from "./theme.ts";
import type { ResolvedTheme, ThemeResolveRequest, ThemeSummary } from "./types.ts";

const USERS = new Map([
	["admin", { id: "u-admin", email: "admin@x.com", name: "Admin" }],
	["plain", { id: "u-plain", email: "plain@x.com", name: "Plain" }],
]);

const authStub = Auth.of({
	setUserBanned: async () => {},
	getSession: async (h: Headers) => {
		const key = /session=([^;]+)/.exec(h.get("cookie") ?? "")?.[1];
		const user = key ? USERS.get(key) : undefined;
		if (!user) return null;
		return {
			user,
			sessionId: `sess-${key}`,
			expiresAt: new Date(Date.now() + 3_600_000),
		};
	},
} as never);

// Mutable service hooks — each test re-points the behavior it needs.
const hooks = {
	resolve: (_request?: ThemeResolveRequest): Effect.Effect<ResolvedTheme> =>
		Effect.succeed(KTB_DEFAULT_THEME),
	list: (): Effect.Effect<ThemeSummary[], Forbidden> => Effect.succeed([]),
	get: (_id: number): Effect.Effect<ResolvedTheme | null, Forbidden> => Effect.succeed(null),
	publish: (input: ThemePublishInput): Effect.Effect<ThemeSummary, Forbidden> =>
		Effect.succeed({
			id: 1,
			scope: input.scope as ThemeSummary["scope"],
			scopeId: input.scopeId,
			appName: input.appName ?? null,
			enabled: true,
			version: 1,
		}),
	setEnabled: (_id: number, _enabled: boolean): Effect.Effect<void, Forbidden> => Effect.void,
	previewRow: (_id: number): Effect.Effect<ThemeRow | null, Forbidden> => Effect.succeed(null),
};

const themeStub = Theme.of({
	resolve: (request) => hooks.resolve(request),
	list: () => hooks.list(),
	get: (id) => hooks.get(id),
	publish: (input) => hooks.publish(input),
	setEnabled: (id, enabled) => hooks.setEnabled(id, enabled),
	previewRow: (id) => hooks.previewRow(id),
});

const infra = Layer.mergeAll(
	Layer.succeed(Auth, authStub),
	Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
	Layer.succeed(Theme, themeStub),
);

const runtime = ManagedRuntime.make(infra as Layer.Layer<unknown, never, never>);

// Runtime whose admin gate defects — resolve still works (it never
// yields PlatformAdmin) while the isAdmin probe rejects into its
// `.catch(() => false)` guard.
const dyingGateRuntime = ManagedRuntime.make(
	Layer.mergeAll(
		Layer.succeed(Auth, authStub),
		Layer.succeed(PlatformAdmin, {
			isAdmin: () => Effect.die(new Error("gate down")),
			requireAdmin: () => Effect.die(new Error("gate down")),
		} as never),
		Layer.succeed(Theme, themeStub),
	) as Layer.Layer<unknown, never, never>,
);

const serverRuntime = {
	run: (effect: Effect.Effect<unknown, unknown, unknown>) => runtime.runPromise(effect as never),
	runAs: (user: { id: string; email?: string }, effect: Effect.Effect<unknown, unknown, unknown>) =>
		runtime.runPromise(
			effect.pipe(
				Effect.provideService(Principal, {
					userId: user.id,
					email: user.email,
				}),
			) as never,
		),
	audioTranscribeModel: "test-model",
	getLocale: () => "en",
	pluginEnabled: async () => true,
};

beforeAll(() => {
	setServerRuntime(serverRuntime as never);
});

afterAll(async () => {
	resetServerRuntime();
	await Promise.all([runtime.dispose(), dyingGateRuntime.dispose()]);
});

const useSession = (key: string | null) => {
	headers.current = key === null ? new Headers() : new Headers({ cookie: `session=${key}` });
};

const previewRowFixture = (id: number): ThemeRow =>
	({
		id,
		scope: "platform",
		scopeId: "",
		appName: "Draft",
		seeds: "{}",
		tokens: "{}",
		fonts: null,
		brand: null,
		enabled: false,
		version: 1,
		createdAt: new Date(0),
		updatedAt: null,
	}) as unknown as ThemeRow;

describe("themeScopeFn", () => {
	it("resolves anonymously through run()", async () => {
		useSession(null);
		const theme = await themeScopeFn({ data: { scope: "session" } });
		expect(theme?.id).toBe(KTB_DEFAULT_THEME.id);
	});

	it("resolves for non-admin sessions without consulting the preview cookie", async () => {
		useSession("plain");
		cookie.value = "12";
		const theme = await themeScopeFn({ data: { scope: "tenant" } });
		expect(theme?.preview).toBeUndefined();
	});

	it("returns the resolved theme for admins without a preview cookie", async () => {
		useSession("admin");
		cookie.value = null;
		const theme = await themeScopeFn({ data: { scope: "platform" } });
		expect(theme?.id).toBe(KTB_DEFAULT_THEME.id);
	});

	it("honors the preview cookie for admins and marks the theme preview", async () => {
		useSession("admin");
		cookie.value = "12";
		hooks.previewRow = (id) => Effect.succeed(previewRowFixture(id));
		try {
			const theme = await themeScopeFn({ data: { scope: "session" } });
			expect(theme?.id).toBe(12);
			expect(theme?.preview).toBe(true);
			expect(theme?.appName).toBe("Draft");
		} finally {
			hooks.previewRow = () => Effect.succeed(null);
			cookie.value = null;
		}
	});

	it("ignores malformed cookie values and cookie read failures", async () => {
		useSession("admin");
		cookie.value = "abc";
		expect((await themeScopeFn({ data: { scope: "session" } }))?.preview).toBeUndefined();
		cookie.getThrows = true;
		try {
			expect((await themeScopeFn({ data: { scope: "session" } }))?.id).toBe(KTB_DEFAULT_THEME.id);
		} finally {
			cookie.getThrows = false;
		}
	});

	it("treats a failing admin gate as non-admin", async () => {
		useSession("admin");
		cookie.value = "12";
		setServerRuntime({
			...serverRuntime,
			runAs: (
				user: { id: string; email?: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				dyingGateRuntime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
					) as never,
				),
		} as never);
		try {
			const theme = await themeScopeFn({ data: { scope: "session" } });
			expect(theme?.id).toBe(KTB_DEFAULT_THEME.id);
			expect(theme?.preview).toBeUndefined();
		} finally {
			setServerRuntime(serverRuntime as never);
			cookie.value = null;
		}
	});

	it("falls back to the resolved theme when previewRow fails", async () => {
		useSession("admin");
		cookie.value = "5";
		hooks.previewRow = () => Effect.fail(new Forbidden({ path: "theme.previewRow" }));
		try {
			const theme = await themeScopeFn({ data: { scope: "session" } });
			expect(theme?.id).toBe(KTB_DEFAULT_THEME.id);
			expect(theme?.preview).toBeUndefined();
		} finally {
			hooks.previewRow = () => Effect.succeed(null);
			cookie.value = null;
		}
	});

	it("rejects invalid scope payloads", async () => {
		useSession("admin");
		await expect(themeScopeFn({ data: { scope: "bogus" } })).rejects.toThrow();
	});
});

describe("listThemesFn", () => {
	it("rejects anonymous callers", async () => {
		useSession(null);
		await expect(listThemesFn()).rejects.toThrow("unauthenticated");
	});

	it("returns summaries for signed-in users", async () => {
		useSession("plain");
		hooks.list = () =>
			Effect.succeed([
				{
					id: 1,
					scope: "platform",
					scopeId: "",
					appName: "P",
					enabled: true,
					version: 2,
				},
			]);
		try {
			expect(await listThemesFn()).toHaveLength(1);
		} finally {
			hooks.list = () => Effect.succeed([]);
		}
	});

	it("degrades Forbidden to an empty list", async () => {
		useSession("plain");
		hooks.list = () => Effect.fail(new Forbidden({ path: "theme.list" }));
		try {
			expect(await listThemesFn()).toEqual([]);
		} finally {
			hooks.list = () => Effect.succeed([]);
		}
	});
});

describe("getThemeFn", () => {
	it("rejects anonymous callers", async () => {
		useSession(null);
		await expect(getThemeFn({ data: { id: 1 } })).rejects.toThrow("unauthenticated");
	});

	it("returns the presented theme or null on Forbidden", async () => {
		useSession("plain");
		hooks.get = (id) =>
			Effect.succeed(
				id === 7
					? presentTheme({
							id: 7,
							scope: "platform",
							scopeId: "",
							appName: null,
							seeds: "{}",
							tokens: "{}",
							fonts: null,
							brand: null,
							enabled: true,
							version: 1,
						} satisfies ThemeDefinitionRow)
					: null,
			);
		try {
			expect((await getThemeFn({ data: { id: 7 } }))?.id).toBe(7);
			expect(await getThemeFn({ data: { id: 8 } })).toBeNull();
			hooks.get = () => Effect.fail(new Forbidden({ path: "theme.get" }));
			expect(await getThemeFn({ data: { id: 7 } })).toBeNull();
		} finally {
			hooks.get = () => Effect.succeed(null);
		}
	});
});

describe("publishThemeFn", () => {
	it("maps the wire payload onto ThemePublishInput", async () => {
		useSession("admin");
		const seen: ThemePublishInput[] = [];
		hooks.publish = (input) => {
			seen.push(input);
			return Effect.succeed({
				id: 3,
				scope: input.scope as ThemeSummary["scope"],
				scopeId: input.scopeId,
				appName: input.appName ?? null,
				enabled: true,
				version: 1,
			});
		};
		try {
			const summary = await publishThemeFn({
				data: {
					scope: "tenant",
					scopeId: "t-1",
					seeds: { primary: "#123456" },
				},
			});
			expect(summary.id).toBe(3);
			expect(seen[0]).toEqual({
				scope: "tenant",
				scopeId: "t-1",
				appName: null,
				seeds: { primary: "#123456" },
				fonts: null,
				brand: null,
			});
			// scopeId is optional on the wire → defaults to "".
			await publishThemeFn({ data: { scope: "platform", seeds: {} } });
			expect(seen[1]?.scopeId).toBe("");
		} finally {
			hooks.publish = (input) =>
				Effect.succeed({
					id: 1,
					scope: input.scope as ThemeSummary["scope"],
					scopeId: input.scopeId,
					appName: input.appName ?? null,
					enabled: true,
					version: 1,
				});
		}
	});

	it("rejects anonymous callers and invalid payloads", async () => {
		useSession(null);
		await expect(publishThemeFn({ data: { scope: "platform", seeds: {} } })).rejects.toThrow(
			"unauthenticated",
		);
		useSession("admin");
		await expect(publishThemeFn({ data: { scope: "session", seeds: {} } })).rejects.toThrow();
		await expect(publishThemeFn({ data: { scope: "platform" } })).rejects.toThrow();
	});
});

describe("setThemeEnabledFn", () => {
	it("toggles and returns ok", async () => {
		useSession("admin");
		const seen: [number, boolean][] = [];
		hooks.setEnabled = (id, enabled) => {
			seen.push([id, enabled]);
			return Effect.void;
		};
		try {
			expect(await setThemeEnabledFn({ data: { id: 4, enabled: false } })).toEqual({ ok: true });
			expect(seen).toEqual([[4, false]]);
		} finally {
			hooks.setEnabled = () => Effect.void;
		}
	});
});

describe("setThemePreviewFn", () => {
	it("rejects anonymous callers", async () => {
		useSession(null);
		await expect(setThemePreviewFn({ data: { themeId: null } })).rejects.toThrow("unauthenticated");
	});

	it("returns ok:false for non-admins without touching cookies", async () => {
		useSession("plain");
		expect(await setThemePreviewFn({ data: { themeId: 3 } })).toEqual({
			ok: false,
		});
		expect(cookie.set).toHaveLength(0);
		expect(cookie.del).toHaveLength(0);
	});

	it("clears the preview cookie for admins", async () => {
		useSession("admin");
		expect(await setThemePreviewFn({ data: { themeId: null } })).toEqual({
			ok: true,
		});
		expect(cookie.del[0]?.[0]).toBe("ktb-theme-preview");
	});

	it("sets the preview cookie with the documented attributes", async () => {
		useSession("admin");
		cookie.set.length = 0;
		expect(await setThemePreviewFn({ data: { themeId: 9 } })).toEqual({
			ok: true,
		});
		expect(cookie.set[0]?.[0]).toBe("ktb-theme-preview");
		expect(cookie.set[0]?.[1]).toBe("9");
		expect(cookie.set[0]?.[2]).toMatchObject({
			httpOnly: true,
			path: "/",
			maxAge: 28800,
		});
	});

	it("returns ok:false when the cookie write throws", async () => {
		useSession("admin");
		cookie.setThrows = true;
		try {
			expect(await setThemePreviewFn({ data: { themeId: 1 } })).toEqual({
				ok: false,
			});
		} finally {
			cookie.setThrows = false;
		}
	});
});
