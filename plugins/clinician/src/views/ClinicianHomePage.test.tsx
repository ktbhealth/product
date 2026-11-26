// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockLocation = vi.hoisted(() => ({ pathname: "/portal/doctor" }));

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
		useLocation: (opts: { select: (l: { pathname: string }) => unknown }) =>
			opts.select({ pathname: mockLocation.pathname }),
	};
});

vi.mock("@ktb/consultations/views", async () => {
	const React = await import("react");
	return {
		WhisperWarmupCard: () => React.createElement("div", null, "whisper-warmup-stub"),
	};
});

import { ClinicianHomePage } from "./ClinicianHomePage.tsx";

const ctx = { plugins: [], locale: "en" };

afterEach(cleanup);
beforeEach(() => {
	mockLocation.pathname = "/portal/doctor";
});

describe("ClinicianHomePage", () => {
	it("renders the workspace directory with links into the portal sections", () => {
		render(<ClinicianHomePage data={null} ctx={ctx} />);
		expect(screen.getByText("Clinician workspace")).toBeTruthy();
		expect(screen.getByText("Patients")).toBeTruthy();
		expect(screen.getByText("Consultations")).toBeTruthy();
		expect(screen.getByText("Patients and consultations for the doctor you act as.")).toBeTruthy();
		const links = screen.getAllByRole("link");
		expect(links).toHaveLength(2);
		for (const link of links) {
			expect(link.getAttribute("href")).toBe("/portal/$instance/$");
		}
	});

	it("mounts the Whisper warm-up card only under the doctor instance", () => {
		render(<ClinicianHomePage data={null} ctx={ctx} />);
		expect(screen.getByText("whisper-warmup-stub")).toBeTruthy();
		cleanup();
		mockLocation.pathname = "/portal/secretary";
		render(<ClinicianHomePage data={null} ctx={ctx} />);
		expect(screen.queryByText("whisper-warmup-stub")).toBeNull();
		expect(screen.getByText("Clinician workspace")).toBeTruthy();
	});
});
