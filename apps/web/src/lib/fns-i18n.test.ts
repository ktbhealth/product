import { beforeAll, describe, expect, it, vi } from "vitest";

import { groupMembers, groups } from "@ktb/db/schema";

// i18nRouteFn edge coverage: failure isolation (H3 — the root loader
// runs this fn on EVERY route, so a broken i18n store must degrade to
// the base-locale slice, not 500) and portal-scope gating (L2 — an
// unregistered /portal/<seg> must not reach portal-scoped rows).
const hoisted = vi.hoisted(() => ({
	failLocales: false,
	throwHeaders: false,
	account: null as null | { id: string; email: string; name: string },
	accountFails: false,
	headers: new Headers(),
	scopeChains: [] as { scopes: readonly { scope: string; scopeId: string }[] }[],
	emptyLocaleChain: false,
}));

vi.mock("@ktb/i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n")>();
	return {
		...actual,
		resolveRequestLocales: (
			...args: Parameters<typeof actual.resolveRequestLocales>
		): ReturnType<typeof actual.resolveRequestLocales> =>
			hoisted.emptyLocaleChain
				? { locales: [], defaultLocale: "en" }
				: actual.resolveRequestLocales(...args),
	};
});

vi.mock("@tanstack/react-start/server", () => ({
	getRequestHeaders: () => {
		if (hoisted.throwHeaders) throw new Error("no request context");
		return hoisted.headers;
	},
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
vi.mock("@ktb/i18n-plugin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n-plugin")>();
	return {
		...actual,
		listEnabledLocales: (...args: Parameters<typeof actual.listEnabledLocales>) =>
			hoisted.failLocales
				? Promise.reject(new Error("i18n_locales unavailable"))
				: actual.listEnabledLocales(...args),
		catalogSlice: (
			db: Parameters<typeof actual.catalogSlice>[0],
			input: Parameters<typeof actual.catalogSlice>[1],
		) => {
			hoisted.scopeChains.push(input.scopeChain);
			return actual.catalogSlice(db, input);
		},
	};
});

// The session lookup is a server-fn port — stub it so tenant-selector
// tests control the account without a real auth session.
vi.mock("#/lib/auth.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/auth.ts")>();
	return {
		...actual,
		getSessionAccount: async () => {
			if (hoisted.accountFails) throw new Error("session store down");
			return hoisted.account;
		},
	};
});

import { db } from "./platform.ts";
import { i18nRouteFn } from "./fns.ts";

// Tenant fixture for the selector path: u1 belongs to "i18n-tenant".
let i18nTenantId = 0;
beforeAll(async () => {
	const [tenant] = await db
		.insert(groups)
		.values({
			name: "I18n Tenant",
			slug: "i18n-tenant",
			kind: "clinic",
			meta: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.returning();
	i18nTenantId = tenant!.id;
	await db.insert(groupMembers).values({
		groupId: tenant!.id,
		memberKind: "user",
		memberId: "u1",
		role: "member",
		createdAt: new Date(),
	});
});

describe("i18nRouteFn failure isolation", () => {
	it("degrades to the empty base-locale slice when i18n resolution fails", async () => {
		hoisted.failLocales = true;
		try {
			const res = await i18nRouteFn({ data: "/consultations" });
			expect(res).toEqual({
				locale: "en",
				locales: ["en"],
				enabledLocales: ["en"],
				namespaces: [],
				catalog: {},
			});
		} finally {
			hoisted.failLocales = false;
		}
	});
});

describe("i18nRouteFn portal scope gating", () => {
	it("scopes copy to a registered portal instance", async () => {
		hoisted.scopeChains.length = 0;
		const res = await i18nRouteFn({ data: "/portal/doctor" });
		expect(res.locale).toBeTruthy();
		expect(hoisted.scopeChains).toHaveLength(1);
		expect(hoisted.scopeChains[0]!.scopes[0]).toEqual({
			scope: "portal",
			scopeId: "doctor",
		});
	});

	it("falls through to global scope for an unregistered /portal/<seg>", async () => {
		hoisted.scopeChains.length = 0;
		const res = await i18nRouteFn({ data: "/portal/not-a-real-instance" });
		expect(res.locale).toBeTruthy();
		expect(hoisted.scopeChains).toHaveLength(1);
		expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope !== "portal")).toBe(true);
	});

	it("treats /platform paths as the console shell, not a portal instance", async () => {
		hoisted.scopeChains.length = 0;
		const res = await i18nRouteFn({ data: "/platform/ops" });
		expect(res.locale).toBeTruthy();
		expect(hoisted.scopeChains).toHaveLength(1);
		expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope === "global")).toBe(true);
	});
});

describe("i18nRouteFn locale chain edge", () => {
	it("serves the default locale when the resolved chain is empty", async () => {
		hoisted.emptyLocaleChain = true;
		try {
			const res = await i18nRouteFn({ data: "/consultations" });
			expect(res.locale).toBe("en");
			expect(res.locales).toEqual([]);
		} finally {
			hoisted.emptyLocaleChain = false;
		}
	});
});

describe("i18nRouteFn tenant scope", () => {
	const reset = () => {
		hoisted.headers = new Headers();
		hoisted.account = null;
		hoisted.accountFails = false;
		hoisted.throwHeaders = false;
		hoisted.scopeChains.length = 0;
	};

	it("binds tenant scope from x-tenant headers + session account", async () => {
		reset();
		try {
			hoisted.headers = new Headers({ "x-tenant-slug": "i18n-tenant" });
			hoisted.account = { id: "u1", email: "u@x.com", name: "U" };
			const res = await i18nRouteFn({ data: "/consultations" });
			expect(res.locale).toBeTruthy();
			expect(hoisted.scopeChains).toHaveLength(1);
			expect(hoisted.scopeChains[0]!.scopes[0]).toEqual({
				scope: "tenant",
				scopeId: String(i18nTenantId),
			});
		} finally {
			reset();
		}
	});

	it("slots tenant scope between portal and global on portal paths", async () => {
		reset();
		try {
			hoisted.headers = new Headers({ "x-tenant-slug": "i18n-tenant" });
			hoisted.account = { id: "u1", email: "u@x.com", name: "U" };
			await i18nRouteFn({ data: "/portal/doctor" });
			expect(hoisted.scopeChains).toHaveLength(1);
			expect(hoisted.scopeChains[0]!.scopes).toEqual([
				{ scope: "portal", scopeId: "doctor" },
				{ scope: "tenant", scopeId: String(i18nTenantId) },
				{ scope: "global", scopeId: "" },
			]);
		} finally {
			reset();
		}
	});

	it("degrades to global scope when the selector resolves nothing", async () => {
		reset();
		try {
			// Unknown slug → TenantNotFound → caught → null tenant.
			hoisted.headers = new Headers({ "x-tenant-slug": "no-such-tenant" });
			hoisted.account = { id: "u1", email: "u@x.com", name: "U" };
			await i18nRouteFn({ data: "/consultations" });
			expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope === "global")).toBe(true);
		} finally {
			reset();
		}
	});

	it("degrades to global scope when the session lookup fails or is anonymous", async () => {
		reset();
		try {
			hoisted.headers = new Headers({ "x-tenant-slug": "i18n-tenant" });
			hoisted.accountFails = true;
			await i18nRouteFn({ data: "/consultations" });
			expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope === "global")).toBe(true);
			hoisted.scopeChains.length = 0;
			hoisted.accountFails = false;
			// Anonymous account → resolver fails TenantNotFound → null.
			await i18nRouteFn({ data: "/consultations" });
			expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope === "global")).toBe(true);
		} finally {
			reset();
		}
	});

	it("falls back to empty headers when getRequestHeaders throws", async () => {
		reset();
		try {
			hoisted.throwHeaders = true;
			const res = await i18nRouteFn({ data: "/consultations" });
			expect(res.locale).toBeTruthy();
			expect(hoisted.scopeChains[0]!.scopes.every((s) => s.scope === "global")).toBe(true);
		} finally {
			reset();
		}
	});
});
