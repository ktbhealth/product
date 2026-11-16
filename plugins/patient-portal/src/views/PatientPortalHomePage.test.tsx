// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectPatientFn: vi.fn<(arg: { data: number }) => Promise<{ ok: boolean }>>(async (_arg) => ({
		ok: true,
	})),
	invalidate: vi.fn<() => void>(),
	props: { current: undefined as Record<string, unknown> | undefined },
}));

const captured = () => {
	if (mocks.props.current === undefined) throw new Error("view captured no props");
	return mocks.props.current;
};

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock("../fns.ts", () => ({
	selectPatientFn: mocks.selectPatientFn,
}));
vi.mock("./PortalPage.tsx", () => ({
	PortalPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "portal-page" });
	},
}));

import { PatientPortalHomePage } from "./PatientPortalHomePage.tsx";

const ctx = { plugins: [], locale: "en" };
const data = {
	view: "home",
	user: { name: "Ana", email: "ana@ktb.test" },
	awaitingInvites: 0,
	profiles: [{ patientId: 1 }],
	profile: { patientId: 1 },
	consultations: [{ id: 10 }],
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	mocks.props.current = undefined;
});

describe("PatientPortalHomePage", () => {
	it("maps loader data and ctx into the portal view", () => {
		render(<PatientPortalHomePage data={data} ctx={ctx} />);
		expect(mocks.props.current).toMatchObject({
			user: { name: "Ana", email: "ana@ktb.test" },
			profiles: [{ patientId: 1 }],
			profile: { patientId: 1 },
			consultations: [{ id: 10 }],
			locale: "en",
		});
	});

	it("renders nothing for missing loader data", () => {
		const { container, unmount } = render(<PatientPortalHomePage data={null} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
		unmount();
		render(<PatientPortalHomePage data={{ view: "missing" }} ctx={ctx} />);
		expect(container.innerHTML).toBe("");
	});

	it("wires the profile switcher to the selection fn and reloads after a change", async () => {
		render(<PatientPortalHomePage data={data} ctx={ctx} />);
		await (captured().api as { select(id: number): Promise<unknown> }).select(2);
		expect(mocks.selectPatientFn).toHaveBeenCalledWith({ data: 2 });
		(captured().onChanged as () => void)();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});
});
