// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	inviteSecretaryFn: vi.fn<(arg: { data: { email: string } }) => Promise<{ ok: boolean }>>(
		async () => ({ ok: true }),
	),
	revokeSecretaryFn: vi.fn<(arg: { data: number }) => Promise<{ ok: boolean }>>(async () => ({
		ok: true,
	})),
	invalidate: vi.fn<() => void>(),
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("../fns.ts", () => ({
	inviteSecretaryFn: mocks.inviteSecretaryFn,
	revokeSecretaryFn: mocks.revokeSecretaryFn,
}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate: mocks.invalidate }),
}));
vi.mock("./SecretariesPage.tsx", () => ({
	SecretariesPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "secretaries" });
	},
}));

import { SecretariesPortalPage } from "./SecretariesPortalPage.tsx";

const ctx = { plugins: [], locale: "pt-BR" };
const props = () =>
	mocks.props.current as {
		secretaries: unknown[];
		locale: string;
		api: {
			invite(email: string): Promise<unknown>;
			revoke(id: number): Promise<unknown>;
		};
		onChanged(): void;
	};

afterEach(cleanup);

describe("SecretariesPortalPage", () => {
	it("hands loader data, locale and the fns to the view", async () => {
		const secretaries = [{ id: 1, email: "ana@ktb.test", status: "active" }];
		render(createElement(SecretariesPortalPage, { data: secretaries, ctx }));
		expect(props()).toMatchObject({ secretaries, locale: "pt-BR" });
		await props().api.invite("new@ktb.test");
		expect(mocks.inviteSecretaryFn).toHaveBeenCalledWith({ data: { email: "new@ktb.test" } });
		await props().api.revoke(5);
		expect(mocks.revokeSecretaryFn).toHaveBeenCalledWith({ data: 5 });
		props().onChanged();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});

	it("treats a forbidden (null) payload as an empty list", () => {
		render(createElement(SecretariesPortalPage, { data: null, ctx }));
		expect(props()).toMatchObject({ secretaries: [] });
	});
});
