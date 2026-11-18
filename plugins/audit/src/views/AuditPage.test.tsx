// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminAuditRow, AuditListQuery, AuditListResult } from "../index.ts";
import { AuditPage } from "./AuditPage.tsx";

const row = (over: Partial<AdminAuditRow>): AdminAuditRow => ({
	id: 1,
	actorUserId: "u1",
	actorEmail: "admin@x.com",
	action: "users.suspend",
	targetType: "user",
	targetId: "u9",
	detail: '{"suspended":true}',
	tenantId: null,
	prevHash: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	...over,
});

const TWO_ROWS = [
	row({}),
	row({
		id: 2,
		actorUserId: null,
		actorEmail: null,
		action: "groups.delete",
		targetType: "group",
		targetId: "4",
		detail: null,
		tenantId: 4,
	}),
];

afterEach(cleanup);

describe("AuditPage", () => {
	it("honors a title override (staff activity feed)", () => {
		render(<AuditPage entries={[]} total={0} locale="en" title="Activity" />);
		expect(screen.getByText("Activity")).toBeTruthy();
		expect(screen.queryByText("Audit log")).toBeNull();
	});

	it("renders the empty state", () => {
		render(<AuditPage entries={[]} total={0} locale="en" />);
		expect(screen.getByText("Audit log")).toBeTruthy();
		expect(screen.getByText("No audit entries")).toBeTruthy();
	});

	it("renders rows with actor, action, target and tenant fallbacks", () => {
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" showTenant />);
		expect(screen.getByText("admin@x.com")).toBeTruthy();
		expect(screen.getByText("users.suspend")).toBeTruthy();
		expect(screen.getByText("user:u9")).toBeTruthy();
		// Second row: no actor → "system", no detail → no JSON button,
		// tenantId 4 → "#4".
		expect(screen.getByText("system")).toBeTruthy();
		expect(screen.getByText("groups.delete")).toBeTruthy();
		expect(screen.getByText("#4")).toBeTruthy();
		expect(screen.getAllByText("JSON")).toHaveLength(1);
		expect(screen.getByText("2 admin actions recorded.")).toBeTruthy();
	});

	it("shows the capped description when total exceeds the page", () => {
		render(<AuditPage entries={TWO_ROWS} total={9} locale="en" />);
		expect(screen.getByText("Latest 2 of 9 admin actions.")).toBeTruthy();
	});

	it("filters rows by the search box", () => {
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		fireEvent.change(screen.getByLabelText("Search audit entries"), {
			target: { value: "groups" },
		});
		expect(screen.queryByText("users.suspend")).toBeNull();
		expect(screen.getByText("groups.delete")).toBeTruthy();
		expect(screen.getByText("Showing 1 of 2")).toBeTruthy();
	});

	it("shows the no-match row when filters exclude everything", () => {
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		fireEvent.change(screen.getByLabelText("Search audit entries"), {
			target: { value: "zzz-no-match" },
		});
		expect(screen.getByText("No entries match the filters.")).toBeTruthy();
	});

	it("filters by action group through the select", async () => {
		const user = userEvent.setup();
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		await user.click(screen.getByLabelText("All actions"));
		await user.click(await screen.findByRole("option", { name: "groups" }));
		expect(screen.queryByText("users.suspend")).toBeNull();
		expect(screen.getByText("groups.delete")).toBeTruthy();
	});

	it("filters by actor through the select and resets with all", async () => {
		const user = userEvent.setup();
		render(
			<AuditPage
				entries={[
					...TWO_ROWS,
					// Email-less actor falls back to actorUserId in the options.
					row({
						id: 3,
						actorEmail: null,
						actorUserId: "u9",
						action: "audit.ping",
						targetType: "audit",
						targetId: null,
						detail: null,
					}),
				]}
				total={3}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "system" }));
		expect(screen.queryByText("users.suspend")).toBeNull();
		expect(screen.getByText("groups.delete")).toBeTruthy();
		// The "all" option restores the full page.
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "All actors" }));
		expect(screen.getByText("users.suspend")).toBeTruthy();
		expect(screen.getByText("groups.delete")).toBeTruthy();
		// actorUserId fallback key filters too.
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "u9" }));
		expect(screen.getByText("audit.ping")).toBeTruthy();
		expect(screen.queryByText("users.suspend")).toBeNull();
	});

	it("filters by target type, labeling null as none", async () => {
		const user = userEvent.setup();
		render(
			<AuditPage
				entries={[
					row({ id: 1, action: "a.one", targetType: "user", targetId: "u1" }),
					row({
						id: 2,
						action: "a.two",
						targetType: null,
						targetId: null,
						detail: null,
					}),
				]}
				total={2}
				locale="en"
			/>,
		);
		await user.click(screen.getByLabelText("All target types"));
		await user.click(await screen.findByRole("option", { name: "none" }));
		expect(screen.queryByText("a.one")).toBeNull();
		expect(screen.getByText("a.two")).toBeTruthy();
		await user.click(screen.getByLabelText("All target types"));
		await user.click(await screen.findByRole("option", { name: "user" }));
		expect(screen.getByText("a.one")).toBeTruthy();
		expect(screen.queryByText("a.two")).toBeNull();
	});

	it("composes the actor filter with the search box", async () => {
		const user = userEvent.setup();
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		fireEvent.change(screen.getByLabelText("Search audit entries"), {
			target: { value: "groups" },
		});
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "admin@x.com" }));
		expect(screen.getByText("No entries match the filters.")).toBeTruthy();
	});

	it("opens the detail dialog with parsed JSON and closes it", async () => {
		const user = userEvent.setup();
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		await user.click(screen.getByText("JSON"));
		expect(screen.getByText("Audit entry")).toBeTruthy();
		expect(screen.getByText(/"suspended": true/)).toBeTruthy();
		// The dialog's built-in close control dismisses via onOpenChange.
		await user.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByText("Audit entry")).toBeNull();
	});

	it("renders raw detail text when the payload is not JSON", async () => {
		const user = userEvent.setup();
		render(<AuditPage entries={[row({ detail: "not-json{{{" })]} total={1} locale="en" />);
		await user.click(screen.getByText("JSON"));
		expect(screen.getByText(/not-json/)).toBeTruthy();
	});

	it("localizes the console in pt-BR", () => {
		render(<AuditPage entries={TWO_ROWS} total={2} locale="pt-BR" />);
		expect(screen.getByText("Log de auditoria")).toBeTruthy();
		expect(screen.getByText(/2 ações de admin registradas/)).toBeTruthy();
	});

	it("handles string/invalid dates, dot-less actions and empty targets", () => {
		render(
			<AuditPage
				entries={[
					row({
						id: 3,
						action: "login",
						targetType: null,
						targetId: null,
						detail: null,
						// Serialized loader payloads carry ISO strings.
						createdAt: "2026-11-01T10:00:00Z" as unknown as Date,
					}),
					row({
						id: 4,
						action: "users.touch",
						targetType: "user",
						targetId: "",
						detail: null,
						createdAt: "not-a-date" as unknown as Date,
					}),
				]}
				total={2}
				locale="en"
				showTenant
			/>,
		);
		// Dot-less action groups under itself; empty targets render "—".
		expect(screen.getByText("login")).toBeTruthy();
		expect(screen.getByText("user")).toBeTruthy();
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("hides the verify action unless onVerify is provided", () => {
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" />);
		expect(screen.queryByText("Verify chain")).toBeNull();
	});

	it("runs onVerify and shows the verified result", async () => {
		const user = userEvent.setup();
		const onVerify = vi.fn(
			async (): Promise<{
				status: "verified";
				entries: number;
				brokenAt: null;
			}> => ({
				status: "verified",
				entries: 2,
				brokenAt: null,
			}),
		);
		render(<AuditPage entries={TWO_ROWS} total={2} locale="en" onVerify={onVerify} />);
		await user.click(screen.getByText("Verify chain"));
		expect(onVerify).toHaveBeenCalledTimes(1);
		expect(await screen.findByText("Chain verified — 2 entries intact.")).toBeTruthy();
	});

	it("shows the tampered result with the broken row id", async () => {
		const user = userEvent.setup();
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={2}
				locale="en"
				onVerify={async () => ({ status: "tampered", entries: 9, brokenAt: 42 })}
			/>,
		);
		await user.click(screen.getByText("Verify chain"));
		expect(await screen.findByText(/first broken link at entry #42/)).toBeTruthy();
	});

	it("shows the empty-log result", async () => {
		const user = userEvent.setup();
		render(
			<AuditPage
				entries={[]}
				total={0}
				locale="en"
				onVerify={async () => ({ status: "empty", entries: 0, brokenAt: null })}
			/>,
		);
		await user.click(screen.getByText("Verify chain"));
		expect(await screen.findByText(/nothing to verify/)).toBeTruthy();
	});

	it("shows the failure message when onVerify resolves null or rejects", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<AuditPage entries={TWO_ROWS} total={2} locale="en" onVerify={async () => null} />,
		);
		await user.click(screen.getByText("Verify chain"));
		expect(await screen.findByText(/Verification failed/)).toBeTruthy();
		rerender(
			<AuditPage
				entries={TWO_ROWS}
				total={2}
				locale="en"
				onVerify={async () => {
					throw new Error("boom");
				}}
			/>,
		);
		await user.click(screen.getByText("Verify chain"));
		expect(await screen.findByText(/Verification failed/)).toBeTruthy();
	});

	it("searches rows with null target ids", () => {
		render(
			<AuditPage
				entries={[
					row({
						id: 5,
						action: "rbac.role.delete",
						targetType: "role",
						targetId: null,
						detail: null,
					}),
					row({ id: 6, action: "users.suspend", targetId: "u9" }),
				]}
				total={2}
				locale="en"
			/>,
		);
		fireEvent.change(screen.getByLabelText("Search audit entries"), {
			target: { value: "rbac" },
		});
		expect(screen.queryByText("users.suspend")).toBeNull();
		expect(screen.getByText("rbac.role.delete")).toBeTruthy();
	});
});

describe("AuditPage server mode (onQuery)", () => {
	const page = (over: Partial<AuditListResult>): AuditListResult => ({
		entries: TWO_ROWS,
		total: 5,
		limit: 2,
		offset: 0,
		...over,
	});

	it("paginates through onQuery and renders the returned page", async () => {
		const user = userEvent.setup();
		const onQuery = vi.fn(async (_query: AuditListQuery) =>
			page({
				entries: [
					row({ id: 3, action: "patients.read", actorEmail: "doc@x.com" }),
					row({ id: 4, action: "groups.update", actorEmail: null, actorUserId: null }),
				],
				offset: 2,
			}),
		);
		render(<AuditPage entries={TWO_ROWS} total={5} limit={2} locale="en" onQuery={onQuery} />);
		expect(screen.getByText("Page 1 of 3")).toBeTruthy();
		await user.click(screen.getByText("Next"));
		expect(onQuery).toHaveBeenCalledWith({ limit: 2, offset: 2 });
		expect(await screen.findByText("patients.read")).toBeTruthy();
		expect(screen.getByText("Page 2 of 3")).toBeTruthy();
		// First page is still reachable.
		await user.click(screen.getByText("Previous"));
		expect(onQuery).toHaveBeenLastCalledWith({ limit: 2, offset: 0 });
	});

	it("debounces the search box into a server query at offset 0", async () => {
		const onQuery = vi.fn(async (_query: AuditListQuery) => page({ total: 1 }));
		render(<AuditPage entries={TWO_ROWS} total={5} limit={2} locale="en" onQuery={onQuery} />);
		fireEvent.change(screen.getByLabelText("Search audit entries"), {
			target: { value: "suspend" },
		});
		await vi.waitFor(() => expect(onQuery).toHaveBeenCalled(), { timeout: 2000 });
		expect(onQuery).toHaveBeenCalledWith({ limit: 2, offset: 0, q: "suspend" });
	});

	it("maps the date inputs to since/until epoch bounds", async () => {
		const user = userEvent.setup();
		const onQuery = vi.fn(async (_query: AuditListQuery) => page({ total: 0, entries: [] }));
		render(<AuditPage entries={TWO_ROWS} total={5} limit={2} locale="en" onQuery={onQuery} />);
		await user.type(screen.getByLabelText("From date"), "2026-11-01");
		await vi.waitFor(() => expect(onQuery).toHaveBeenCalled(), { timeout: 2000 });
		const call = onQuery.mock.calls.at(-1)?.[0];
		expect(typeof call?.since).toBe("number");
	});

	it("drops a stale response that resolves after a newer query", async () => {
		const user = userEvent.setup();
		let resolveStale: ((r: AuditListResult) => void) | undefined;
		const onQuery = vi.fn((query: AuditListQuery) => {
			if (query.offset === 2) {
				return new Promise<AuditListResult>((res) => {
					resolveStale = res;
				});
			}
			return Promise.resolve(
				page({
					entries: [row({ id: 9, action: "fresh.action", actorEmail: "new@x.com" })],
					total: 9,
					limit: 2,
					offset: 0,
				}),
			);
		});
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={5}
				limit={2}
				locale="en"
				onQuery={onQuery}
				onFacets={async () => ({ actionGroups: ["patients"], actors: [], targetTypes: [] })}
			/>,
		);
		await user.click(screen.getByText("Next"));
		// A filter change fires a newer query while the pager request hangs.
		await user.click(screen.getByLabelText("All actions"));
		await user.click(await screen.findByRole("option", { name: "patients" }));
		expect(await screen.findByText("fresh.action")).toBeTruthy();
		// The stale page-2 response lands last — it must be dropped.
		resolveStale!(
			page({
				entries: [row({ id: 8, action: "stale.action" })],
				total: 5,
				limit: 2,
				offset: 2,
			}),
		);
		await vi.waitFor(() => expect(screen.queryByText("stale.action")).toBeNull());
		expect(screen.getByText("fresh.action")).toBeTruthy();
	});

	it("ignores a stale rejection after a newer query succeeded", async () => {
		const user = userEvent.setup();
		let rejectStale: ((e: unknown) => void) | undefined;
		const onQuery = vi.fn((query: AuditListQuery) => {
			if (query.offset === 2) {
				return new Promise<AuditListResult>((_res, rej) => {
					rejectStale = rej;
				});
			}
			return Promise.resolve(
				page({
					entries: [row({ id: 9, action: "fresh.action" })],
					total: 9,
					limit: 2,
					offset: 0,
				}),
			);
		});
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={5}
				limit={2}
				locale="en"
				onQuery={onQuery}
				onFacets={async () => ({ actionGroups: ["patients"], actors: [], targetTypes: [] })}
			/>,
		);
		await user.click(screen.getByText("Next"));
		await user.click(screen.getByLabelText("All actions"));
		await user.click(await screen.findByRole("option", { name: "patients" }));
		expect(await screen.findByText("fresh.action")).toBeTruthy();
		rejectStale!(new Error("late failure"));
		await vi.waitFor(() => expect(screen.queryByText(/Could not load entries/)).toBeNull());
		expect(screen.getByText("fresh.action")).toBeTruthy();
	});

	it("shows a load-failed message when onQuery resolves null", async () => {
		const user = userEvent.setup();
		const onQuery = vi.fn(async (_query: AuditListQuery) => null);
		render(<AuditPage entries={TWO_ROWS} total={5} limit={2} locale="en" onQuery={onQuery} />);
		await user.click(screen.getByText("Next"));
		expect(await screen.findByText(/Could not load entries/)).toBeTruthy();
	});

	it("loads facets once and uses them for the dropdown options", async () => {
		const onFacets = vi.fn(async () => ({
			actionGroups: ["patients"],
			actors: ["doc@x.com", null],
			targetTypes: ["patient", null],
		}));
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={2}
				locale="en"
				onQuery={vi.fn(async () => page({ total: 2 }))}
				onFacets={onFacets}
			/>,
		);
		expect(onFacets).toHaveBeenCalledTimes(1);
		// Facet values replaced the entries-derived options — "patients"
		// is not derivable from TWO_ROWS' actions.
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("All actions"));
		expect(await screen.findByText("patients")).toBeTruthy();
	});

	it("maps select filters to the query — group, system actor, no-target, to-date", async () => {
		const user = userEvent.setup();
		const onQuery = vi.fn(async (_query: AuditListQuery) => page({ total: 1 }));
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={5}
				limit={2}
				locale="en"
				onQuery={onQuery}
				onFacets={async () => ({
					actionGroups: ["patients"],
					actors: ["doc@clinic.com", null],
					targetTypes: ["patient", null],
				})}
			/>,
		);
		// Action group.
		await user.click(screen.getByLabelText("All actions"));
		await user.click(await screen.findByRole("option", { name: "patients" }));
		expect(onQuery).toHaveBeenLastCalledWith({ limit: 2, offset: 0, actionGroup: "patients" });
		// System actor → explicit null (the NULL bucket).
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "system" }));
		expect(onQuery).toHaveBeenLastCalledWith({
			limit: 2,
			offset: 0,
			actionGroup: "patients",
			actor: null,
		});
		// "none" target type → explicit null.
		await user.click(screen.getByLabelText("All target types"));
		await user.click(await screen.findByRole("option", { name: "none" }));
		expect(onQuery).toHaveBeenLastCalledWith({
			limit: 2,
			offset: 0,
			actionGroup: "patients",
			actor: null,
			targetType: null,
		});
		// A concrete actor and target type pass through as strings.
		await user.click(screen.getByLabelText("All actors"));
		await user.click(await screen.findByRole("option", { name: "doc@clinic.com" }));
		expect(onQuery).toHaveBeenLastCalledWith({
			limit: 2,
			offset: 0,
			actionGroup: "patients",
			actor: "doc@clinic.com",
			targetType: null,
		});
		await user.click(screen.getByLabelText("All target types"));
		await user.click(await screen.findByRole("option", { name: "patient" }));
		expect(onQuery).toHaveBeenLastCalledWith({
			limit: 2,
			offset: 0,
			actionGroup: "patients",
			actor: "doc@clinic.com",
			targetType: "patient",
		});
		// From/to dates → since/until epoch bounds.
		await user.type(screen.getByLabelText("From date"), "2026-11-01");
		await user.type(screen.getByLabelText("To date"), "2026-11-30");
		await vi.waitFor(() => {
			const call = onQuery.mock.calls.at(-1)?.[0];
			expect(typeof call?.since).toBe("number");
			expect(typeof call?.until).toBe("number");
		});
	});

	it("shows the failure message when onQuery rejects", async () => {
		const user = userEvent.setup();
		const onQuery = vi.fn(async (_query: AuditListQuery): Promise<AuditListResult> => {
			throw new Error("boom");
		});
		render(<AuditPage entries={TWO_ROWS} total={5} limit={2} locale="en" onQuery={onQuery} />);
		await user.click(screen.getByText("Next"));
		expect(await screen.findByText(/Could not load entries/)).toBeTruthy();
	});

	it("detail dialog falls back through actor, target, tenant and hash", async () => {
		const user = userEvent.setup();
		const sparse = row({
			id: 7,
			actorUserId: "u7",
			actorEmail: null,
			action: "orphan.action",
			targetType: null,
			targetId: null,
			detail: '{"sparse":true}',
			tenantId: 4,
			prevHash: "abcdef0123456789ffff",
		});
		const { unmount } = render(<AuditPage entries={[sparse]} total={1} locale="en" showTenant />);
		await user.click(screen.getAllByText("JSON")[0]!);
		expect((await screen.findAllByText("u7")).length).toBeGreaterThan(0);
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
		expect(screen.getAllByText("#4").length).toBeGreaterThan(0);
		expect(screen.getByText("abcdef0123456789…")).toBeTruthy();
		expect(screen.getByText(/"sparse": true/)).toBeTruthy();
		unmount();
		// Tenant-less row → "—" tenant; system actor → "system".
		render(
			<AuditPage
				entries={[
					row({
						actorUserId: null,
						actorEmail: null,
						tenantId: null,
						detail: '{"x":1}',
					}),
				]}
				total={1}
				locale="en"
				showTenant
			/>,
		);
		await user.click(screen.getAllByText("JSON")[0]!);
		expect((await screen.findAllByText("system")).length).toBeGreaterThan(0);
	});

	it("resyncs page state when loader props change", () => {
		const onQuery = vi.fn(async (_query: AuditListQuery) => page({}));
		const { rerender } = render(
			<AuditPage entries={TWO_ROWS} total={2} locale="en" onQuery={onQuery} />,
		);
		expect(screen.getByText("users.suspend")).toBeTruthy();
		rerender(
			<AuditPage
				entries={[row({ id: 9, action: "patients.merge", actorEmail: "other@x.com" })]}
				total={1}
				offset={0}
				locale="en"
				onQuery={onQuery}
			/>,
		);
		expect(screen.getByText("patients.merge")).toBeTruthy();
		expect(screen.queryByText("users.suspend")).toBeNull();
		rerender(
			<AuditPage entries={TWO_ROWS} total={2} limit={5} offset={0} locale="en" onQuery={onQuery} />,
		);
		expect(screen.getByText("users.suspend")).toBeTruthy();
	});

	it("ignores a null facets result", async () => {
		const user = userEvent.setup();
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={2}
				locale="en"
				onQuery={vi.fn(async () => page({ total: 2 }))}
				onFacets={async () => null}
			/>,
		);
		await user.click(screen.getByLabelText("All actions"));
		expect(await screen.findByText("users")).toBeTruthy();
	});

	it("keeps entries-derived options when facets fail", async () => {
		render(
			<AuditPage
				entries={TWO_ROWS}
				total={2}
				locale="en"
				onQuery={vi.fn(async () => page({ total: 2 }))}
				onFacets={async () => {
					throw new Error("facets down");
				}}
			/>,
		);
		const user = userEvent.setup();
		await user.click(screen.getByLabelText("All actors"));
		// Table cell + select item both carry the actor — at least two.
		expect((await screen.findAllByText("admin@x.com")).length).toBeGreaterThanOrEqual(2);
	});
});
