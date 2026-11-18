import { describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

const mocks = vi.hoisted(() => ({
	redirectToPortal: vi.fn(async (_subpath: string) => undefined as never),
}));

vi.mock("./guard.ts", () => ({ redirectToPortal: mocks.redirectToPortal }));
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

import { Route as IndexRoute } from "./routes/index.tsx";
import { Route as NewRoute } from "./routes/new.tsx";
import { Route as DetailRoute } from "./routes/$id/index.tsx";
import { Route as EditRoute } from "./routes/$id/edit.tsx";

type BeforeLoad = (arg: { params?: { id: string } }) => unknown;
const beforeLoadOf = (route: unknown) =>
	(route as { options: { beforeLoad: BeforeLoad } }).options.beforeLoad;
const componentOf = (route: unknown) =>
	(route as { options: { component: () => unknown } }).options.component;

describe("/patients* legacy redirects", () => {
	it("/patients funnels to the portal list", async () => {
		await expect(beforeLoadOf(IndexRoute)({})).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/patients");
	});

	it("/patients/new funnels to the portal form", async () => {
		await expect(beforeLoadOf(NewRoute)({})).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/patients/new");
	});

	it("/patients/$id funnels to the portal record", async () => {
		await expect(beforeLoadOf(DetailRoute)({ params: { id: "9" } })).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/patients/9");
	});

	it("/patients/$id/edit funnels to the portal edit form", async () => {
		await expect(beforeLoadOf(EditRoute)({ params: { id: "9" } })).resolves.toBeUndefined();
		expect(mocks.redirectToPortal).toHaveBeenCalledWith("/patients/9/edit");
	});

	it("renders nothing — the funnel lives in beforeLoad", () => {
		for (const route of [IndexRoute, NewRoute, DetailRoute, EditRoute]) {
			expect(componentOf(route)()).toBeNull();
		}
	});
});
