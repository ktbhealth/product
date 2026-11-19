// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createElement, useContext } from "react";
import { NotificationsActionsContext, type NotificationsActions } from "@ktb/notifications/context";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A host that registers none of the optional header plugins: the shell
// must skip the jobs/notifications feeds and render no header actions.
const adminListAudioJobsFn = vi.fn(async () => [] as unknown[]);
const adminListConsultationsFn = vi.fn(async () => [] as unknown[]);
const adminListPatientsFn = vi.fn(async () => [] as unknown[]);
const listMyNotificationsFn = vi.fn(async () => [] as unknown[]);
const countMyUnreadNotificationsFn = vi.fn(async () => 0);
const pluginStatesFn = vi.fn(async () => ({ enabled: [] as string[] }));
const portalPageDataFn = vi.fn(async (_path: string) => ({ status: "ok", data: null }));

vi.mock("#/plugins.ts", () => ({ plugins: [] }));
vi.mock("#/lib/fns.ts", () => ({
	platformAdminFn: vi.fn(async () => true),
	portalAudiencesFn: vi.fn(async () => [] as string[]),
	portalPageDataFn: (arg: { data: string }) => portalPageDataFn(arg.data),
	pluginStatesFn: () => pluginStatesFn(),
	listMyNotificationsFn: () => listMyNotificationsFn(),
	countMyUnreadNotificationsFn: () => countMyUnreadNotificationsFn(),
	markMyNotificationsReadFn: vi.fn(),
	markAllMyNotificationsReadFn: vi.fn(),
	getSessionUserFn: vi.fn(async () => ({ id: "u1", email: "a@x.com", name: "A" })),
	consoleDeniedFn: vi.fn(async (): Promise<string[]> => []),
	i18nRouteFn: vi.fn(async () => undefined),
}));
// The dispatcher imports the audio-jobs and dashboard feed fns from the
// domain plugins directly — stub those modules the same way.
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
vi.mock("@ktb/auth-better/client", () => ({ authClient: { signOut: vi.fn() } }));

let pathname = "/platform";

beforeAll(() => {
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
			useLoaderData: () => ({ user: null, pluginStates: { enabled: [] } }),
		}),
		Link: (props: Record<string, unknown>) => {
			const { to, children, ...rest } = props;
			return React.createElement("a", { href: to as string, ...rest }, children as never);
		},
	};
});

import { platformLoader, PlatformShell } from "./platform-dispatch.tsx";
import { portalPages } from "#/lib/registry.ts";
import type { PanelPage } from "@ktb/kernel";

const registerPage = (path: string, component: PanelPage["component"]) => {
	const pages = portalPages as unknown as Map<string, { page: PanelPage; pluginId: string }>;
	pages.set(path, { page: { id: "test.probe", path, component }, pluginId: "platform.routes" });
	return () => pages.delete(path);
};

const loaderData = {
	path: "/platform/probe",
	pageData: null,
	audioJobs: [] as unknown[],
	notifications: [] as unknown[],
	consultations: [] as unknown[],
	patients: [] as unknown[],
	unreadCount: undefined as number | undefined,
	audiences: [] as string[],
	theme: null,
	deniedPaths: [] as string[],
	pluginStates: { enabled: [] as string[] },
};

afterEach(() => {
	cleanup();
	pathname = "/platform";
	vi.clearAllMocks();
	pluginStatesFn.mockResolvedValue({ enabled: [] });
	portalPageDataFn.mockResolvedValue({ status: "ok", data: null });
});

describe("platform dispatch without the optional header plugins", () => {
	it("loader skips the jobs, notifications, and dashboard feeds", async () => {
		const unregister = registerPage("/platform/probe", () => null);
		try {
			// entryEnabled is per-id for unstamped entries — keep the page
			// owner enabled so the loader reaches the feed gates.
			pluginStatesFn.mockResolvedValue({ enabled: ["platform.routes"] });
			const res = (await platformLoader({ params: { _splat: "platform/probe" } })) as Record<
				string,
				unknown
			>;
			expect(res).toMatchObject({
				path: "/platform/probe",
				audioJobs: [],
				notifications: [],
				consultations: [],
				patients: [],
				unreadCount: undefined,
			});
			expect(adminListAudioJobsFn).not.toHaveBeenCalled();
			expect(adminListConsultationsFn).not.toHaveBeenCalled();
			expect(adminListPatientsFn).not.toHaveBeenCalled();
			expect(listMyNotificationsFn).not.toHaveBeenCalled();
			expect(countMyUnreadNotificationsFn).not.toHaveBeenCalled();
		} finally {
			unregister();
		}
	});

	it("renders the shell with no notification actions and the account fallback label", () => {
		let actions: NotificationsActions | null | undefined;
		const unregister = registerPage("/platform/probe", () => {
			actions = useContext(NotificationsActionsContext);
			return createElement("div", null, "PROBE");
		});
		try {
			render(createElement(PlatformShell, { loaderData: loaderData as never }));
			expect(actions).toBeNull();
			expect(screen.getByText("account")).toBeTruthy();
		} finally {
			unregister();
		}
	});
});
