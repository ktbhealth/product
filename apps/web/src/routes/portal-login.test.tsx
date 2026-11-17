import { describe, expect, it } from "vitest";

import { Route } from "./portal-login.tsx";

const options = (
	Route as unknown as {
		options: {
			beforeLoad: () => Promise<void>;
			component: () => null;
		};
	}
).options;

describe("/portal/login redirect", () => {
	it("sends visitors to the patient sign-in", () => {
		let caught: unknown;
		try {
			void options.beforeLoad();
		} catch (e) {
			caught = e;
		}
		expect(caught).toMatchObject({ options: { href: "/login/patient" } });
	});

	it("renders nothing", () => {
		expect(options.component()).toBeNull();
	});
});
