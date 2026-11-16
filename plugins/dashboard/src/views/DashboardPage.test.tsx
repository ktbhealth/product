// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import type { Plugin } from "@ktb/kernel";
import type { AdminConsultationRow } from "@ktb/consultations";
import type { AdminPatientRow } from "@ktb/patients";
import { makePatient } from "@ktb/patients/testing";

import { DashboardPage } from "./DashboardPage.tsx";

const patient = (over: Partial<AdminPatientRow>): AdminPatientRow => ({
	...makePatient({ name: "Ana" }),
	ownerEmail: "d@x.com",
	ownerName: "Dra",
	...over,
});

const consultation = (over: Partial<AdminConsultationRow>): AdminConsultationRow => ({
	id: 1,
	userId: "u1",
	patientId: null,
	transcript: "t",
	anamnesis: null,
	review: null,
	engine: null,
	source: "browser",
	status: "done",
	botId: null,
	consentAt: null,
	audioKey: null,
	audioStatus: "none",
	audioContentType: null,
	audioSize: null,
	audioError: null,
	serverTranscript: null,
	correctedTranscript: null,
	enhancementEngine: null,
	anamnesisHash: null,
	anamnesisVersion: null,
	blobHash: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	ownerEmail: "d@x.com",
	ownerName: "Dra",
	patientName: null,
	tenantId: null,
	...over,
});

const plugin = (id: string, sidebar = 0): Plugin =>
	sidebar
		? {
				id,
				chrome: [
					{
						id: `${id}.sidebar`,
						region: "portal.sidebar",
						content: { kind: "sidebarItem", item: { to: "/x", label: id } },
					},
				],
			}
		: { id };

const Landing = () => null;

afterEach(cleanup);

describe("DashboardPage", () => {
	it("renders stat cards and empty states", () => {
		render(<DashboardPage patients={[]} consultations={[]} plugins={[plugin("a.b")]} />);
		expect(screen.getByText("Dashboard")).toBeTruthy();
		expect(screen.getByText("Patients")).toBeTruthy();
		expect(screen.getByText("Consultations")).toBeTruthy();
		expect(screen.getByText("Live now")).toBeTruthy();
		expect(screen.getByText("Plugins")).toBeTruthy();
		expect(screen.getAllByText("No consultations yet.").length).toBeGreaterThan(0);
		expect(screen.getByText("a.b")).toBeTruthy();
	});

	it("renders counts, recent consultations and plugin contributions", () => {
		render(
			<DashboardPage
				patients={[patient({}), patient({ id: 2, name: "Bia" })]}
				consultations={[
					consultation({ id: 9, status: "live", source: "bot" }),
					consultation({ id: 8 }),
				]}
				plugins={[plugin("x.y", 2)]}
			/>,
		);
		// Stat values (patients count and consultations count are both 2).
		expect(screen.getAllByText("2")).toHaveLength(2);
		// "live"/"bot" appear both in the breakdown cards and the table.
		expect(screen.getAllByText("live").length).toBeGreaterThan(0);
		expect(screen.getAllByText("bot").length).toBeGreaterThan(0);
		expect(screen.getByText("x.y")).toBeTruthy();
		expect(screen.getByText("chrome")).toBeTruthy();
	});

	it("hides the console-activity card when notifications are not provided", () => {
		render(<DashboardPage patients={[]} consultations={[]} plugins={[]} />);
		expect(screen.queryByText("Console activity")).toBeNull();
	});

	it("renders the console-activity card with unread count and recent notifications", () => {
		render(
			<DashboardPage
				patients={[]}
				consultations={[]}
				plugins={[]}
				unreadCount={2}
				notifications={[
					{
						id: "3",
						title: "Patient created",
						description: "Ana",
						read: false,
						meta: "patient.created",
					},
					{ id: "2", title: "Consultation started", read: true, meta: "consultation.created" },
					{ id: "1", title: "Patient deleted", read: true },
				]}
			/>,
		);
		expect(screen.getByText("Console activity")).toBeTruthy();
		expect(screen.getByText("Unread notifications")).toBeTruthy();
		expect(screen.getByText("Patient created")).toBeTruthy();
		expect(screen.getByText("Ana")).toBeTruthy();
		expect(screen.getByText("patient.created")).toBeTruthy();
		expect(screen.getByText("Consultation started")).toBeTruthy();
	});

	it("caps the activity list at five and shows the empty state", () => {
		const six = Array.from({ length: 6 }, (_, i) => ({
			id: String(i + 1),
			title: `N${i + 1}`,
			read: true,
		}));
		const { unmount } = render(
			<DashboardPage patients={[]} consultations={[]} plugins={[]} notifications={six} />,
		);
		expect(screen.getByText("N1")).toBeTruthy();
		expect(screen.queryByText("N6")).toBeNull();
		unmount();
		render(<DashboardPage patients={[]} consultations={[]} plugins={[]} notifications={[]} />);
		expect(screen.getByText("No notifications yet.")).toBeTruthy();
	});

	it("lists landing and panel pages among a plugin's contributions", () => {
		const Page = () => null;
		render(
			<DashboardPage
				patients={[]}
				consultations={[]}
				plugins={[
					{ id: "site.landing", landing: { page: Landing } },
					{
						id: "site.panel",
						panel: { pages: [{ id: "p", path: "/platform/x", component: Page }] },
					},
				]}
			/>,
		);
		expect(screen.getByText("landing")).toBeTruthy();
		expect(screen.getByText("panel")).toBeTruthy();
	});

	it("falls back from the owner name to the email and then to a dash", () => {
		render(
			<DashboardPage
				patients={[]}
				consultations={[
					consultation({ id: 3, ownerName: null, ownerEmail: "only@x.com" }),
					consultation({ id: 2, ownerName: null, ownerEmail: null }),
				]}
				plugins={[]}
			/>,
		);
		expect(screen.getByText("only@x.com")).toBeTruthy();
		expect(screen.getByText("—")).toBeTruthy();
	});

	it("renders breakdowns and plugin enable-state badges", () => {
		render(
			<DashboardPage
				patients={[]}
				consultations={[
					consultation({ id: 1, status: "live", source: "bot" }),
					consultation({ id: 2, status: "done", source: "browser" }),
					consultation({ id: 3, status: "done", source: "browser" }),
					consultation({ id: 4, status: "archived", source: "browser" }),
				]}
				plugins={[plugin("a.b"), plugin("c.d")]}
				pluginStates={[
					{ pluginId: "a.b", enabled: true, system: false, config: null },
					{ pluginId: "c.d", enabled: false, system: false, config: null },
				]}
			/>,
		);
		expect(screen.getByText("Consultations by status")).toBeTruthy();
		expect(screen.getByText("By source")).toBeTruthy();
		expect(screen.getByText("1/2")).toBeTruthy();
		expect(screen.getByText("Enabled")).toBeTruthy();
		expect(screen.getByText("Disabled")).toBeTruthy();
	});

	it("marks system plugins and defaults missing state entries to enabled", () => {
		render(
			<DashboardPage
				patients={[]}
				consultations={[]}
				plugins={[plugin("sys.p"), plugin("plain.p")]}
				pluginStates={[{ pluginId: "sys.p", enabled: true, system: true, config: null }]}
			/>,
		);
		expect(screen.getByText("System")).toBeTruthy();
		expect(screen.getByText("Enabled")).toBeTruthy();
	});

	it("renders plugin-contributed dashboard slots and hides disabled plugins' entries", () => {
		const StatWidget = () => <div>custom stat</div>;
		const SectionWidget = () => <div>custom section</div>;
		const slotPlugin = (id: string): Plugin => ({
			id,
			chrome: [
				{
					id: `${id}.stat`,
					region: "portal.dashboard.stats",
					content: { kind: "component", component: StatWidget },
				},
				{
					id: `${id}.sec`,
					region: "portal.dashboard.sections",
					content: { kind: "component", component: SectionWidget },
				},
				// Non-component contents are ignored by the dashboard slots.
				{
					id: `${id}.lnk`,
					region: "portal.dashboard.stats",
					content: { kind: "link", to: "/x", label: "L" },
				},
			],
		});
		render(
			<DashboardPage
				patients={[]}
				consultations={[]}
				plugins={[slotPlugin("w.one"), slotPlugin("w.two")]}
				pluginStates={[{ pluginId: "w.two", enabled: false, system: false, config: null }]}
			/>,
		);
		expect(screen.getAllByText("custom stat")).toHaveLength(1);
		expect(screen.getAllByText("custom section")).toHaveLength(1);
	});

	it("lists routes, chrome, tables and services among a plugin's contributions", () => {
		const everything = {
			id: "full.stack",
			routes: [{ path: "/x" }],
			chrome: [
				{
					id: "c",
					region: "app.header.nav",
					content: { kind: "link", to: "/a", label: "A" },
				},
			],
			tables: {},
			services: {},
		} as unknown as Plugin;
		render(<DashboardPage patients={[]} consultations={[]} plugins={[everything]} />);
		expect(screen.getByText("routes, chrome, tables, services")).toBeTruthy();
	});
});
