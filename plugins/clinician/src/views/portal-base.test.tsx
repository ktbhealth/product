// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pathname: { current: "/portal/doctor/patients" } }));

vi.mock("@tanstack/react-router", () => ({
	useLocation: (opts: { select: (l: { pathname: string }) => string }) =>
		opts.select({ pathname: mocks.pathname.current }),
}));

import { usePortalBase, usePortalInstanceId } from "./portal-base.ts";

const Probe = () => {
	const instance = usePortalInstanceId();
	const base = usePortalBase();
	return createElement("output", { "data-testid": "probe" }, `${instance}|${base}`);
};

afterEach(() => {
	cleanup();
	mocks.pathname.current = "/portal/doctor/patients";
});

describe("portal-base hooks", () => {
	it("derives the instance id and base path from the pathname", () => {
		const { getByTestId } = render(createElement(Probe));
		expect(getByTestId("probe").textContent).toBe("doctor|/portal/doctor");
	});

	it("falls back to an empty instance on a shallow portal path", () => {
		mocks.pathname.current = "/portal";
		const { getByTestId } = render(createElement(Probe));
		expect(getByTestId("probe").textContent).toBe("|/portal/");
	});
});
