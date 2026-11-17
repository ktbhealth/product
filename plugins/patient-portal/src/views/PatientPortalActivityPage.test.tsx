// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("./PortalActivityPage.tsx", () => ({
	PortalActivityPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "portal-activity" });
	},
}));

import { PatientPortalActivityPage } from "./PatientPortalActivityPage.tsx";

const ctx = { plugins: [], locale: "pt-BR" };

afterEach(() => {
	cleanup();
	mocks.props.current = undefined;
});

describe("PatientPortalActivityPage", () => {
	it("maps loader data and the host locale onto the shared audit table", () => {
		const data = { entries: [{ id: 1 }], total: 1, limit: 100 };
		render(<PatientPortalActivityPage data={data} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({ data, locale: "pt-BR" });
	});
});
