// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selectDoctorFn: vi.fn<(arg: { data: number }) => Promise<{ ok: boolean }>>(async () => ({
		ok: true,
	})),
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("../fns.ts", () => ({ selectDoctorFn: mocks.selectDoctorFn }));
vi.mock("./DoctorSelectPage.tsx", () => ({
	DoctorSelectPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "chooser" });
	},
}));

import { DoctorSelectPortalPage } from "./DoctorSelectPortalPage.tsx";

const ctx = { plugins: [], locale: "pt-BR" };
const props = () =>
	mocks.props.current as {
		profiles: unknown[];
		activeDoctorId: number | null;
		locale: string;
		api: { select(id: number): Promise<unknown> };
		onDone(profile: { role: string }): void;
	};

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

describe("DoctorSelectPortalPage", () => {
	it("hands loader data, locale and the select fn to the view", async () => {
		const profiles = [{ doctorId: 1, displayName: "Dra", role: "owner" }];
		render(createElement(DoctorSelectPortalPage, { data: { profiles, activeDoctorId: 1 }, ctx }));
		expect(props()).toMatchObject({ profiles, activeDoctorId: 1, locale: "pt-BR" });
		await props().api.select(2);
		expect(mocks.selectDoctorFn).toHaveBeenCalledWith({ data: 2 });
	});

	it("lands in the picked role's portal", () => {
		const assign = vi.fn<(url: string) => void>();
		vi.stubGlobal("location", { assign });
		render(
			createElement(DoctorSelectPortalPage, {
				data: { profiles: [], activeDoctorId: null },
				ctx,
			}),
		);
		props().onDone({ role: "owner" });
		expect(assign).toHaveBeenCalledWith("/portal/doctor");
		props().onDone({ role: "secretary" });
		expect(assign).toHaveBeenCalledWith("/portal/secretary");
	});

	it("tolerates missing loader data", () => {
		render(createElement(DoctorSelectPortalPage, { data: null, ctx }));
		expect(props()).toMatchObject({ profiles: [], activeDoctorId: null });
	});
});
