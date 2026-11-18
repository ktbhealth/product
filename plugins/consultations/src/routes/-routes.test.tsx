import { describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

const mocks = vi.hoisted(() => ({
	redirectToPortal: vi.fn(async (_subpath: string) => undefined as never),
}));

vi.mock("../guard.ts", () => ({ redirectToPortal: mocks.redirectToPortal }));
// Server fns become plain async calls; with no runtime registered the
// plugin route gate (createPluginFileRoute → pluginEnabledFn) is inert.
vi.mock("@tanstack/react-start", () => reactStartMock());
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
	};
});

import { Route as IndexRoute } from "./index.tsx";
import { Route as NewRoute } from "./new.tsx";
import { Route as DetailRoute } from "./$id.tsx";

type BeforeLoad = (arg: { location?: { searchStr: string }; params?: { id: string } }) => unknown;
const beforeLoadOf = (route: unknown) =>
	(route as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad;
const componentOf = (route: unknown) =>
	(route as { options: { component: () => unknown } }).options.component;

describe("/consultations* legacy redirects", () => {
	it("/consultations funnels to the portal list", async () => {
		await expect(beforeLoadOf(IndexRoute)({})).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/consultations");
	});

	it("/consultations/new keeps the ?patientId= prefill search", async () => {
		await expect(
			beforeLoadOf(NewRoute)({ location: { searchStr: "?patientId=5" } }),
		).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/consultations/new?patientId=5");
	});

	it("/consultations/$id funnels to the portal record", async () => {
		await expect(beforeLoadOf(DetailRoute)({ params: { id: "9" } })).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/consultations/9");
	});

	it("renders nothing — the funnel lives in beforeLoad", () => {
		for (const route of [IndexRoute, NewRoute, DetailRoute]) {
			expect(componentOf(route)()).toBeNull();
		}
	});
});
