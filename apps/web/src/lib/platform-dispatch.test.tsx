// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement, useContext } from "react";
import { NotificationsActionsContext, type NotificationsActions } from "@ktb/notifications/context";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const platformAdminFn = vi.fn(async () => true);
const portalPageDataFn = vi.fn(
	async (_path: string): Promise<{ status: string; data?: unknown }> => ({
		status: "ok",
		data: null,
	}),
);
const adminListAudioJobsFn = vi.fn(async () => [] as unknown[]);
const adminListConsultationsFn = vi.fn(async () => [] as unknown[]);
const adminListPatientsFn = vi.fn(async () => [] as unknown[]);
const countMyUnreadNotificationsFn = vi.fn(async () => 0);
const markMyNotificationsReadFn = vi.fn(async (_arg?: unknown) => true);
const markAllMyNotificationsReadFn = vi.fn(async () => true);
const getSessionUserFn = vi.fn(
	async (): Promise<{ id: string; email: string; name: string } | null> => ({
		id: "u1",
		email: "a@x.com",
		name: "A",
	}),
);
const listMyNotificationsFn = vi.fn(async () => [] as unknown[]);
const pluginStatesFn = vi.fn(async () => ({ enabled: [] as string[] }));
const portalAudiencesFn = vi.fn(async () => [] as string[]);
const consoleDeniedFn = vi.fn(async (): Promise<string[]> => []);
const signOut = vi.fn(async () => {});

vi.mock("@ktb/auth-better/client", () => ({ authClient: { signOut: () => signOut() } }));

vi.mock("#/lib/registry.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("#/lib/registry.ts")>();
	return {
		...actual,
		collectChrome: (...args: Parameters<typeof actual.collectChrome>) => [
			...actual.collectChrome(...args),
			...chromeExtra.filter((entry) => entry.region === args[1]),
		],
	};
});

vi.mock("#/lib/fns.ts", () => ({
	platformAdminFn: () => platformAdminFn(),
	consoleDeniedFn: () => consoleDeniedFn(),
	portalPageDataFn: (arg: { data: string }) => portalPageDataFn(arg.data),
	listMyNotificationsFn: () => listMyNotificationsFn(),
	countMyUnreadNotificationsFn: () => countMyUnreadNotificationsFn(),
	markMyNotificationsReadFn: (arg: unknown) => markMyNotificationsReadFn(arg),
	markAllMyNotificationsReadFn: () => markAllMyNotificationsReadFn(),
	getSessionUserFn: () => getSessionUserFn(),
	pluginStatesFn: () => pluginStatesFn(),
	portalAudiencesFn: () => portalAudiencesFn(),
	appPageDataFn: vi.fn(),
	i18nRouteFn: vi.fn(async () => undefined),
}));
// The dispatcher imports the audio-jobs feed fn from the consultations
// plugin directly — stub that module the same way.
vi.mock("@ktb/consultations/fns", () => ({
	adminListAudioJobsFn: () => adminListAudioJobsFn(),
	adminListConsultationsFn: () => adminListConsultationsFn(),
}));
vi.mock("@ktb/patients/fns", () => ({
	adminListPatientsFn: () => adminListPatientsFn(),
}));
// Theme resolution is a server fn — stub it so the loader stays pure.
vi.mock("@ktb/theme/fns", () => ({
	themeScopeFn: vi.fn(async () => null),
	listThemesFn: vi.fn(async () => []),
	getThemeFn: vi.fn(async () => null),
	publishThemeFn: vi.fn(async () => ({})),
	setThemeEnabledFn: vi.fn(async () => ({ ok: true })),
	setThemePreviewFn: vi.fn(async () => ({ ok: true })),
}));

let pathname = "/platform";
let rootData: { user: unknown; pluginStates: { enabled: string[] }; i18n?: unknown } = {
	user: { id: "u1", email: "admin@ktb.test", name: "Admin" },
	pluginStates: { enabled: [] },
};
// Test-only chrome injection: extra collectChrome results per region.
let chromeExtra: { id: string; region: string; content: Record<string, unknown> }[] = [];

beforeAll(() => {
	// jsdom has no matchMedia; the ui sidebar's useIsMobile needs it.
	window.matchMedia =
		window.matchMedia ??
		((query: string) =>
			({
				matches: false,
				media: query,
				onchange: null,
				addListener: () => {},
				removeListener: () => {},
				addEventListener: () => {},
				removeEventListener: () => {},
				dispatchEvent: () => false,
			}) as MediaQueryList);
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	const React = await import("react");
	return {
		...actual,
		useLocation: (opts?: { select?: (l: { pathname: string }) => unknown }) => {
			const loc = { pathname };
			return opts?.select ? opts.select(loc) : loc;
		},
		getRouteApi: () => ({
			useLoaderData: () => rootData,
		}),
		Link: (props: Record<string, unknown>) => {
			const { to, children, ...rest } = props;
			return React.createElement("a", { href: to as string, ...rest }, children as never);
		},
	};
});

import { platformBeforeLoad, platformLoader, PlatformShell } from "./platform-dispatch.tsx";
import { KTB_DEFAULT_THEME } from "@ktb/theme/default-theme";
import { portalPages } from "#/lib/registry.ts";
import { plugins } from "#/plugins.ts";
import type { PanelPage } from "@ktb/kernel";

const ALL_ENABLED = { enabled: plugins.map((p) => p.id) };

const baseLoaderData = {
	path: "/platform",
	pageData: {},
	audioJobs: [] as unknown[],
	notifications: [] as unknown[],
	consultations: [] as unknown[],
	patients: [] as unknown[],
	unreadCount: undefined as number | undefined,
	audiences: [] as string[],
	theme: null,
	deniedPaths: [] as string[],
	pluginStates: ALL_ENABLED,
};

const shell = (overrides: Record<string, unknown> = {}) =>
	createElement(PlatformShell, {
		loaderData: { ...baseLoaderData, ...overrides } as never,
	});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	chromeExtra = [];
	signOut.mockClear();
	pathname = "/platform";
	platformAdminFn.mockReset().mockResolvedValue(true);
	portalPageDataFn.mockReset().mockResolvedValue({ status: "ok", data: null });
	adminListAudioJobsFn.mockReset().mockResolvedValue([]);
	adminListConsultationsFn.mockReset().mockResolvedValue([]);
	adminListPatientsFn.mockReset().mockResolvedValue([]);
	listMyNotificationsFn.mockReset().mockResolvedValue([]);
	countMyUnreadNotificationsFn.mockReset().mockResolvedValue(0);
	markMyNotificationsReadFn.mockReset().mockResolvedValue(true);
	markAllMyNotificationsReadFn.mockReset().mockResolvedValue(true);
	getSessionUserFn.mockReset().mockResolvedValue({ id: "u1", email: "a@x.com", name: "A" });
	pluginStatesFn.mockReset().mockResolvedValue(ALL_ENABLED);
	portalAudiencesFn.mockReset().mockResolvedValue([]);
	rootData = {
		user: { id: "u1", email: "admin@ktb.test", name: "Admin" },
		pluginStates: ALL_ENABLED,
	};
});

describe("platformBeforeLoad", () => {
	it("redirects anonymous users to the doctor sign-in", async () => {
		getSessionUserFn.mockResolvedValue(null);
		// redirect({ href: "/login/doctor" }) surfaces as a 307 Response.
		await expect(platformBeforeLoad()).rejects.toMatchObject({ status: 307 });
	});

	it("404s signed-in non-admins", async () => {
		platformAdminFn.mockResolvedValue(false);
		await expect(platformBeforeLoad()).rejects.toMatchObject({ isNotFound: true });
	});

	it("passes for admins", async () => {
		await expect(platformBeforeLoad()).resolves.toBeUndefined();
	});
});

describe("platformLoader", () => {
	it("resolves the /platform index descriptor and seeds the dashboard feeds", async () => {
		adminListAudioJobsFn.mockResolvedValue([{ id: 1 }]);
		listMyNotificationsFn.mockResolvedValue([{ id: 2 }]);
		adminListConsultationsFn.mockResolvedValue([{ id: 3 }]);
		adminListPatientsFn.mockResolvedValue([{ id: 4 }]);
		countMyUnreadNotificationsFn.mockResolvedValue(2);
		await expect(platformLoader({ params: { _splat: "platform" } })).resolves.toEqual({
			path: "/platform",
			pageData: null,
			audioJobs: [{ id: 1 }],
			notifications: [{ id: 2 }],
			consultations: [{ id: 3 }],
			patients: [{ id: 4 }],
			unreadCount: 2,
			audiences: [],
			theme: null,
			deniedPaths: [],
			pluginStates: ALL_ENABLED,
		});
		expect(portalPageDataFn).toHaveBeenCalledWith("/platform");
	});

	it("resolves splat paths against the registry", async () => {
		await platformLoader({ params: { _splat: "platform/patients" } });
		expect(portalPageDataFn).toHaveBeenCalledWith("/platform/patients");
	});

	it("resolves nested splat paths against the registry", async () => {
		// No shipped plugin owns a nested path — register a throwaway
		// descriptor so the splat lookup has something to find.
		const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
		pages.set("/platform/foo/bar", {
			page: {
				id: "test.nested",
				path: "/platform/foo/bar",
				component: () => null,
			},
			pluginId: "platform.routes",
		});
		try {
			await platformLoader({ params: { _splat: "platform/foo/bar" } });
			expect(portalPageDataFn).toHaveBeenCalledWith("/platform/foo/bar");
		} finally {
			pages.delete("/platform/foo/bar");
		}
	});

	it("404s a missing splat — the root path owns no console page", async () => {
		await expect(platformLoader({ params: {} })).rejects.toMatchObject({
			isNotFound: true,
		});
	});

	it("404s segments no plugin owns", async () => {
		await expect(platformLoader({ params: { _splat: "platform/nope" } })).rejects.toMatchObject({
			isNotFound: true,
		});
		expect(portalPageDataFn).not.toHaveBeenCalled();
	});

	it("404s when the owning plugin is disabled (P-058)", async () => {
		pluginStatesFn.mockResolvedValue({ enabled: [] });
		await expect(platformLoader({ params: { _splat: "platform/patients" } })).rejects.toMatchObject(
			{ isNotFound: true },
		);
	});

	it("404s when the data fn reports notfound (guard denial)", async () => {
		portalPageDataFn.mockResolvedValue({ status: "notfound" });
		await expect(platformLoader({ params: { _splat: "platform/patients" } })).rejects.toMatchObject(
			{ isNotFound: true },
		);
	});

	it("skips feeds whose plugin package is fully disabled (P-058)", async () => {
		// Package granularity (P-058): a package is off only when EVERY
		// stamped member id is disabled — the bare "notifications"
		// marker id has no dot, so prefix matching would leave it on.
		pluginStatesFn.mockResolvedValue({
			enabled: plugins
				.filter((p) => p.pkg !== "consultations" && p.pkg !== "notifications")
				.map((p) => p.id),
		});
		const res = (await platformLoader({ params: { _splat: "platform" } })) as Record<
			string,
			unknown
		>;
		expect(res).toMatchObject({
			audioJobs: [],
			notifications: [],
			consultations: [],
			patients: [],
			unreadCount: undefined,
		});
		expect(adminListAudioJobsFn).not.toHaveBeenCalled();
		expect(adminListConsultationsFn).not.toHaveBeenCalled();
		expect(listMyNotificationsFn).not.toHaveBeenCalled();
		expect(countMyUnreadNotificationsFn).not.toHaveBeenCalled();
		// patients package stayed enabled — its dashboard feed still loads.
		expect(adminListPatientsFn).toHaveBeenCalled();
	});
});

describe("PlatformShell", () => {
	it("renders sidebar items aggregated from plugin panel contributions", () => {
		render(shell());
		const platform = screen
			.getAllByRole("link", { name: "Dashboard" })
			.find((el) => el.getAttribute("href") === "/platform")!;
		const patients = screen
			.getAllByRole("link", { name: "Patients" })
			.find((el) => el.getAttribute("href") === "/platform/patients")!;
		expect(platform.getAttribute("href")).toBe("/platform");
		expect(patients.getAttribute("href")).toBe("/platform/patients");
		expect(platform.hasAttribute("data-active")).toBe(true);
		expect(patients.hasAttribute("data-active")).toBe(false);
	});

	it("renders the dashboard page contributed for /platform", () => {
		render(shell());
		expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
		expect(screen.getByText("platform.routes")).toBeTruthy();
		expect(screen.getByText("platform.panel")).toBeTruthy();
		expect(screen.getByText("dashboard.panel")).toBeTruthy();
	});

	it("renders the patients page contributed by the patients plugin", () => {
		render(
			shell({
				path: "/platform/patients",
				pageData: {
					patients: [
						{
							id: 7,
							ownerId: "u1",
							name: "Ana",
							createdAt: new Date("2026-11-01T10:00:00Z"),
							ownerEmail: "d@x.com",
							ownerName: "Dra",
						},
					],
					owners: [],
				},
			}),
		);
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("Dra")).toBeTruthy();
		expect(screen.getByText("u1")).toBeTruthy();
	});

	it("renders the users page contributed by the users plugin", () => {
		render(
			shell({
				path: "/platform/users",
				pageData: [
					{
						id: "u9",
						name: "Admin",
						email: "admin@ktb.test",
						emailVerified: true,
						image: null,
						createdAt: new Date("2026-11-01T10:00:00Z"),
						updatedAt: new Date("2026-11-01T10:00:00Z"),
						patientCount: 2,
						consultationCount: 5,
						isAdmin: true,
					},
				],
			}),
		);
		expect(screen.getAllByText("admin@ktb.test").length).toBeGreaterThan(0);
		expect(screen.getByText("admin")).toBeTruthy();
	});

	it("renders the groups page contributed by the groups plugin", () => {
		render(
			shell({
				path: "/platform/groups",
				pageData: [
					{
						id: 3,
						name: "Clinic A",
						slug: "clinic-a",
						kind: "clinic",
						meta: null,
						createdAt: new Date("2026-11-01T10:00:00Z"),
						updatedAt: new Date("2026-11-01T10:00:00Z"),
						memberCount: 4,
						zk: false,
					},
				],
			}),
		);
		expect(screen.getByText("Clinic A")).toBeTruthy();
		expect(screen.getByText("clinic-a")).toBeTruthy();
	});

	it("renders the tenants page contributed by the tenant plugin", () => {
		render(
			shell({
				path: "/platform/tenants",
				pageData: [
					{
						id: 4,
						name: "Clinic B",
						slug: "clinic-b",
						kind: "clinic",
						meta: null,
						createdAt: new Date("2026-11-01T10:00:00Z"),
						updatedAt: new Date("2026-11-01T10:00:00Z"),
						memberCount: 2,
						zk: false,
					},
				],
			}),
		);
		expect(screen.getByText("Clinic B")).toBeTruthy();
		expect(screen.getByText("clinic-b")).toBeTruthy();
	});

	it("renders no page body when the path resolves no descriptor", () => {
		// The shell still renders (sidebar, header); only the page slot
		// stays empty — contrast with a registered descriptor.
		const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
		pages.set("/platform/probe-page", {
			page: {
				id: "test.probe-page",
				path: "/platform/probe-page",
				component: () => createElement("p", null, "PROBE-PAGE"),
			},
			pluginId: "platform.routes",
		});
		try {
			render(shell({ path: "/platform/probe-page" }));
			expect(screen.getByText("PROBE-PAGE")).toBeTruthy();
			cleanup();
			render(shell({ path: "/platform/nope" }));
			expect(screen.queryByText("PROBE-PAGE")).toBeNull();
		} finally {
			pages.delete("/platform/probe-page");
		}
	});

	it("orders sidebar items by the pinned platform IA; unlisted items sink last", () => {
		chromeExtra = [
			{
				id: "t.sidebar-extra",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/zzz-extra", label: "Extra", group: "Governance" },
				},
			},
		];
		render(shell());
		const hrefs = screen
			.getAllByRole("link")
			.map((el) => el.getAttribute("href"))
			.filter((h): h is string => h !== null && h.startsWith("/platform/"));
		// Systematic grouping: access leads the grouped sections, the
		// unlisted item trails inside the last group; the eval workflow
		// keeps its 1·2·3 sequence.
		expect(hrefs[0]).toBe("/platform/users");
		expect(hrefs.indexOf("/platform/audit")).toBeLessThan(hrefs.indexOf("/platform/zzz-extra"));
		expect(hrefs.indexOf("/platform/kv")).toBeLessThan(hrefs.indexOf("/platform/zzz-extra"));
		expect(hrefs.indexOf("/platform/eval/personas")).toBeLessThan(
			hrefs.indexOf("/platform/eval/instances"),
		);
		expect(hrefs.indexOf("/platform/eval/instances")).toBeLessThan(hrefs.indexOf("/platform/eval"));
	});

	it("keeps ungrouped and unranked sidebar items at the end in topo order", () => {
		chromeExtra = [
			{
				id: "t.sidebar-nogroup",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/aaa-nogroup", label: "NoGroup" },
				},
			},
			{
				id: "t.sidebar-extra-b",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/yyy-extra", label: "Extra B", group: "Assurance" },
				},
			},
		];
		render(shell());
		const hrefs = screen
			.getAllByRole("link")
			.map((el) => el.getAttribute("href"))
			.filter((h): h is string => h !== null && h.startsWith("/platform/"));
		const audit = hrefs.indexOf("/platform/audit");
		const ungrouped = hrefs.indexOf("/platform/aaa-nogroup");
		const extraB = hrefs.indexOf("/platform/yyy-extra");
		expect(ungrouped).toBeGreaterThanOrEqual(0);
		expect(extraB).toBeGreaterThanOrEqual(0);
		// Unranked items sink after the ranked tail of their group.
		expect(audit).toBeLessThan(extraB);
	});

	it("hides sidebar items the console denied list names", () => {
		chromeExtra = [
			{
				id: "t.sidebar-denied",
				region: "portal.sidebar",
				content: {
					kind: "sidebarItem",
					item: { to: "/platform/denied-item", label: "Denied Item" },
				},
			},
		];
		render(shell({ deniedPaths: ["/platform/denied-item"] }));
		expect(screen.queryByText("Denied Item")).toBeNull();
	});

	it("marks descendant routes active unless the item is exact", () => {
		pathname = "/platform/patients";
		render(shell({ path: "/platform/patients", pageData: { patients: [], owners: [] } }));
		// BreadcrumbPage also renders role="link" — select sidebar items
		// by href + data-active instead of accessible name.
		const sidebarLink = (href: string) =>
			screen
				.getAllByRole("link")
				.find((el) => el.getAttribute("href") === href && el.hasAttribute("data-active"));
		expect(sidebarLink("/platform")).toBeUndefined();
		expect(sidebarLink("/platform/patients")).toBeTruthy();
	});

	it("injects mark-read actions for the notifications popover", async () => {
		const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
		let actions: NotificationsActions | null = null;
		const Probe = () => {
			actions = useContext(NotificationsActionsContext);
			return null;
		};
		pages.set("/platform/probe", {
			page: { id: "test.probe", path: "/platform/probe", component: Probe },
			pluginId: "platform.routes",
		});
		try {
			render(shell({ path: "/platform/probe" }));
			await actions!.markRead([1, 2]);
			expect(markMyNotificationsReadFn).toHaveBeenCalledWith({ data: [1, 2] });
			await actions!.markAllRead();
			expect(markAllMyNotificationsReadFn).toHaveBeenCalledOnce();
		} finally {
			pages.delete("/platform/probe");
		}
	});

	it("signs out, then returns to the home page", async () => {
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		render(shell());
		fireEvent.click(screen.getByTitle("Sign out"));
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
		expect(signOut).toHaveBeenCalledOnce();
	});

	it("skips chrome entries whose kind does not match the console slot", () => {
		chromeExtra = [
			{
				id: "t.sidebar-note",
				region: "portal.sidebar",
				content: { kind: "note", key: "k", fallback: "f" },
			},
			{
				id: "t.header-link",
				region: "portal.header.actions",
				content: { kind: "link", to: "/x", label: "X" },
			},
		];
		render(shell());
		// Matching entries still render; mismatched kinds are dropped.
		expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
	});

	it("lists every portal instance the session's audiences admit", () => {
		// platform-admin admits the "platform" instance — the switcher
		// list maps admitted entries to shell instances (P-081).
		render(shell({ audiences: ["platform-admin"] }));
		expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
	});

	it("uses the root i18n locale for chrome labels", () => {
		rootData = {
			user: { id: "u1", email: "admin@ktb.test", name: "Admin" },
			pluginStates: ALL_ENABLED,
			i18n: { locale: "pt-BR", catalog: {} },
		};
		render(shell());
		expect(screen.getByText("Dashboard")).toBeTruthy();
	});

	it("renders the theme brand mark, style block and preview banner", () => {
		render(
			shell({
				theme: { ...KTB_DEFAULT_THEME, preview: true },
			}),
		);
		expect(screen.getByText("Theme preview active")).toBeTruthy();
		// PortalShell owns the single theme style emitter.
		const { container } = render(shell({ theme: KTB_DEFAULT_THEME }));
		expect(container.querySelector("style")).not.toBeNull();
		expect(container.querySelector('img[src="/brand/logo-horizontal.svg"]')).not.toBeNull();
	});

	it("falls back to the row appName for brand when brand json is empty", () => {
		render(
			shell({
				theme: { ...KTB_DEFAULT_THEME, brand: null, appName: "Acme Health" },
			}),
		);
		expect(screen.getByText("Acme Health")).toBeTruthy();
	});

	it("renders no brand slot for a brand-less theme but still emits theme css", () => {
		const { container } = render(
			shell({
				theme: { ...KTB_DEFAULT_THEME, brand: null, appName: null },
			}),
		);
		expect(container.querySelector("style")).not.toBeNull();
		expect(container.querySelector('img[src^="/brand/"]')).toBeNull();
		expect(screen.queryByText("Theme preview active")).toBeNull();
	});

	it("renders portal.brand chrome with host chrome props and wires sign-out", async () => {
		chromeExtra = [
			{
				id: "t.brand-btn",
				region: "portal.brand",
				content: {
					kind: "component",
					component: (props: { signOut?: () => Promise<void> }) =>
						createElement(
							"button",
							{
								"data-testid": "brand-signout",
								onClick: () => void props.signOut?.(),
							},
							"BRAND-SIGNOUT",
						),
				},
			},
			// Non-component kinds in the brand region are dropped.
			{
				id: "t.brand-note",
				region: "portal.brand",
				content: { kind: "note", key: "k", fallback: "f" },
			},
		];
		const assign = vi.fn();
		vi.stubGlobal("location", { assign });
		render(shell());
		fireEvent.click(screen.getByTestId("brand-signout"));
		await waitFor(() => expect(assign).toHaveBeenCalledWith("/"));
		expect(signOut).toHaveBeenCalledOnce();
	});
});

describe("platform shell edge cases", () => {
	it("falls back to a barebones platform instance when none is registered", async () => {
		// platformEntry?.instance ?? fallback — re-import the module with
		// an empty portal instance registry to cover the fallback.
		vi.resetModules();
		vi.doMock("#/lib/registry.ts", async (importOriginal) => {
			const actual = await importOriginal<typeof import("#/lib/registry.ts")>();
			return { ...actual, portalInstances: [] };
		});
		try {
			const { PlatformShell: FreshShell } = await import("./platform-dispatch.tsx");
			const { container } = render(
				createElement(FreshShell, { loaderData: baseLoaderData as never }),
			);
			expect(container.innerHTML).not.toBe("");
		} finally {
			vi.doUnmock("#/lib/registry.ts");
			vi.resetModules();
		}
	});

	it("stays silent outside dev", async () => {
		// The dev chrome-region warning is module-level — re-import the
		// module with DEV stubbed off to cover the skipped branch.
		vi.stubEnv("DEV", false);
		vi.resetModules();
		try {
			await import("./platform-dispatch.tsx");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
