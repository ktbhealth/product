// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
	invalidate: vi.fn<() => Promise<void>>(async () => {}),
	navigate: vi.fn<(opts: unknown) => Promise<void>>(async () => {}),
	pathname: "/portal/doctor/agenda",
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children?: unknown }) => (
		<a href={to}>{children as never}</a>
	),
	useLocation: (opts: { select: (l: { pathname: string }) => unknown }) =>
		opts.select({ pathname: routerMocks.pathname }),
	useRouter: () => ({
		invalidate: routerMocks.invalidate,
		navigate: routerMocks.navigate,
	}),
}));

const agendaApiMocks = vi.hoisted(() => ({
	create: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	update: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	setStatus: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	start: vi.fn<() => Promise<{ ok: boolean; consultationId?: number }>>(async () => ({
		ok: true,
		consultationId: 42,
	})),
}));

vi.mock("../apis.ts", () => ({ agendaApi: agendaApiMocks }));

// Base UI's Select needs pointer/portal plumbing jsdom lacks — stub it
// with always-visible option buttons wired to onValueChange.
const selectMock = vi.hoisted(() => ({
	onValueChange: (_value: string | null) => {},
}));

vi.mock("@ktbhealth/ui/components/select", async () => {
	const React = await import("react");
	const Item = ({ children, value }: { children?: unknown; value: string }) =>
		React.createElement(
			"button",
			{ type: "button", onClick: () => selectMock.onValueChange(value) },
			children as never,
		);
	return {
		Select: ({
			onValueChange,
			children,
		}: {
			onValueChange?: (v: string | null) => void;
			children?: unknown;
		}) => {
			selectMock.onValueChange = onValueChange ?? (() => {});
			return React.createElement("div", null, children as never);
		},
		SelectTrigger: ({ children, ...props }: { children?: unknown }) =>
			React.createElement("button", { type: "button", ...props }, children as never),
		SelectValue: () => null,
		SelectContent: ({ children }: { children?: unknown }) =>
			React.createElement(
				"div",
				null,
				children as never,
				React.createElement(
					"button",
					{ type: "button", onClick: () => selectMock.onValueChange(null) },
					"Clear",
				),
			),
		SelectItem: Item,
	};
});

import {
	AgendaPage,
	AgendaPortalPage,
	type AgendaApi,
	type AgendaListItem,
	type AppointmentWriteResult,
} from "./AgendaPage.tsx";

const api = () => ({
	create: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	update: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	setStatus: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: true })),
	start: vi.fn<() => Promise<{ ok: boolean; consultationId?: number }>>(async () => ({
		ok: true,
		consultationId: 42,
	})),
});

const appt = (over: Partial<AgendaListItem>): AgendaListItem => ({
	id: 1,
	patientId: 1,
	patientName: "Ana",
	status: "scheduled",
	startsAt: new Date(),
	durationMin: 30,
	consultationId: null,
	note: null,
	reminderSentAt: null,
	...over,
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
	routerMocks.pathname = "/portal/doctor/agenda";
	window.history.replaceState(null, "", "/portal/doctor/agenda");
});

describe("AgendaPage", () => {
	it("renders the empty state when the week has no appointments", () => {
		render(<AgendaPage appointments={[]} patients={[]} api={api()} />);
		expect(screen.getByText("No appointments in this period.")).toBeTruthy();
	});

	it("shows the starting-soon badge for appointments inside the lead window", () => {
		render(
			<AgendaPage
				appointments={[appt({ startsAt: new Date(Date.now() + 5 * 60 * 1000) })]}
				patients={[]}
				api={api()}
			/>,
		);
		expect(screen.getByText(/Starts in \d+ min/)).toBeTruthy();
	});

	it("renders the locked placeholder for ciphertext patient names", () => {
		render(
			<AgendaPage
				appointments={[appt({ patientName: "v1.ciphertext" })]}
				patients={[]}
				api={api()}
			/>,
		);
		expect(screen.getByText("Locked record")).toBeTruthy();
		// Plain names and bare ids render directly.
		render(<AgendaPage appointments={[appt({ patientName: null })]} patients={[]} api={api()} />);
		expect(screen.getByText("#1")).toBeTruthy();
	});

	it("renders note and duration under the patient name", () => {
		render(
			<AgendaPage
				appointments={[appt({ note: "bring exams", durationMin: 45 })]}
				patients={[]}
				api={api()}
			/>,
		);
		expect(screen.getByText(/45 min · bring exams/)).toBeTruthy();
	});

	it("confirm + cancel actions call the api and refresh", async () => {
		const a = api();
		const onChanged = vi.fn<() => void>();
		render(<AgendaPage appointments={[appt({})]} patients={[]} api={a} onChanged={onChanged} />);
		fireEvent.click(screen.getByText("Confirm"));
		await waitFor(() => expect(a.setStatus).toHaveBeenCalledWith(1, "confirmed"));
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
		fireEvent.click(screen.getByText("Cancel"));
		await waitFor(() => expect(a.setStatus).toHaveBeenCalledWith(1, "cancelled"));
	});

	it("start opens the created consultation", async () => {
		const a = api();
		const onStarted = vi.fn<(id: number) => void>();
		render(<AgendaPage appointments={[appt({})]} patients={[]} api={a} onStarted={onStarted} />);
		fireEvent.click(screen.getByText("Start consult"));
		await waitFor(() => expect(a.start).toHaveBeenCalledWith(1));
		await waitFor(() => expect(onStarted).toHaveBeenCalledWith(42));
	});

	it("shows the connect state when Google Calendar is not connected", async () => {
		const a: AgendaApi = {
			...api(),
			calendarConnection: vi.fn<NonNullable<AgendaApi["calendarConnection"]>>(async () => ({
				ok: true as const,
				connection: null,
			})),
		};
		render(<AgendaPage appointments={[]} patients={[]} api={a} />);
		expect(await screen.findByText("Connect Google Calendar")).toBeTruthy();
	});

	it("surfaces the OAuth callback outcome once and strips the query parameter", async () => {
		window.history.pushState(null, "", "/portal/doctor/agenda?calendarImport=connected");
		render(<AgendaPage appointments={[]} patients={[]} api={api()} />);
		expect(await screen.findByText("Google Calendar connected.")).toBeTruthy();
		expect(window.location.search).toBe("");
	});

	it("imports Google events from the connected state and shows the summary", async () => {
		const importGoogleCalendar = vi.fn<NonNullable<AgendaApi["importGoogleCalendar"]>>(
			async () => ({
				ok: true as const,
				result: {
					imported: 1,
					existing: 2,
					skipped: 1,
					review: [{}],
					conflicts: [],
				},
			}),
		);
		const onChanged = vi.fn<() => void>();
		const a: AgendaApi = {
			...api(),
			calendarConnection: vi.fn<NonNullable<AgendaApi["calendarConnection"]>>(async () => ({
				ok: true as const,
				connection: {
					provider: "google",
					calendarId: "primary",
					status: "active",
					lastSyncAt: null,
				},
			})),
			importGoogleCalendar,
		};
		render(<AgendaPage appointments={[]} patients={[]} api={a} onChanged={onChanged} />);
		fireEvent.click(await screen.findByText("Import from Google"));
		await waitFor(() => expect(importGoogleCalendar).toHaveBeenCalled());
		expect(await screen.findByText(/1 imported · 2 already existed/)).toBeTruthy();
		await waitFor(() => expect(onChanged).toHaveBeenCalled());
	});

	it("surfaces the error copy when an op is denied", async () => {
		const a = {
			...api(),
			setStatus: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: false })),
		};
		render(<AgendaPage appointments={[appt({})]} patients={[]} api={a} />);
		fireEvent.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
	});

	it("start denial surfaces the error copy too", async () => {
		const a = {
			...api(),
			start: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: false })),
		};
		render(<AgendaPage appointments={[appt({})]} patients={[]} api={a} />);
		fireEvent.click(screen.getByText("Start consult"));
		await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
	});

	it("a linked consultation renders the open-consult link instead of start", () => {
		render(
			<AgendaPage
				appointments={[appt({ consultationId: 9 })]}
				patients={[]}
				api={api()}
				portalBase="/portal/doctor"
			/>,
		);
		expect(screen.getByText("Open consult")).toBeTruthy();
		expect(screen.queryByText("Start consult")).toBeNull();
	});

	it("confirmed appointments offer complete + no-show", async () => {
		const a = api();
		render(<AgendaPage appointments={[appt({ status: "confirmed" })]} patients={[]} api={a} />);
		fireEvent.click(screen.getByText("Complete"));
		await waitFor(() => expect(a.setStatus).toHaveBeenCalledWith(1, "completed"));
		fireEvent.click(screen.getByText("No-show"));
		await waitFor(() => expect(a.setStatus).toHaveBeenCalledWith(1, "no_show"));
	});

	it("week navigation shifts the rendered days", () => {
		render(<AgendaPage appointments={[]} patients={[]} api={api()} />);
		const headings = () => screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
		const first = headings();
		fireEvent.click(screen.getByLabelText("Next week"));
		expect(headings()).not.toEqual(first);
		fireEvent.click(screen.getByLabelText("Previous week"));
		fireEvent.click(screen.getByLabelText("Previous week"));
		expect(headings()).not.toEqual(first);
		fireEvent.click(screen.getByText("Today"));
		expect(headings()).toEqual(first);
	});

	it("the edit dialog submits the patch through api.update", async () => {
		const a = api();
		render(
			<AgendaPage
				appointments={[appt({ note: "old note" })]}
				patients={[{ id: 1, name: "Ana" }]}
				api={a}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Edit"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith(
				1,
				expect.objectContaining({ patientId: 1, note: "old note" }),
			),
		);
	});

	it("the create dialog opens and closes without submitting", async () => {
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={api()} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Cancel")).toBeTruthy());
		fireEvent.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.queryByText("Cancel")).toBeNull());
	});

	it("the create dialog submits the draft through api.create", async () => {
		const a = api();
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		// Default date/time are valid; the mocked select lists options inline.
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith(
				expect.objectContaining({ patientId: 1, durationMin: 30 }),
			),
		);
	});

	it("select clear resets the patient pick", async () => {
		const a = api();
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(screen.getByText("Clear"));
		fireEvent.click(screen.getByText("Save"));
		// Cleared selection -> the empty-patient guard short-circuits.
		expect(a.create).not.toHaveBeenCalled();
	});

	it("the create dialog treats an empty duration as unset", async () => {
		const a = api();
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.change(document.getElementById("appointment-duration")!, {
			target: { value: "" },
		});
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith(
				expect.objectContaining({ patientId: 1, durationMin: undefined }),
			),
		);
	});

	it("a second submit while busy is ignored", async () => {
		let release!: (v: { ok: boolean }) => void;
		const pending = new Promise<{ ok: boolean }>((r) => {
			release = r;
		});
		const a = {
			...api(),
			update: vi.fn<() => Promise<{ ok: boolean }>>(() => pending),
		};
		render(<AgendaPage appointments={[appt({})]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByLabelText("Edit"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.click(screen.getByText("Save"));
		fireEvent.click(screen.getByText("Save"));
		expect(a.update).toHaveBeenCalledTimes(1);
		release({ ok: true });
		await waitFor(() => expect(screen.queryByText("Save")).toBeNull());
	});

	it("renders fallback copy for unknown statuses, string dates and null names", async () => {
		render(
			<AgendaPage
				appointments={[
					appt({
						status: "mystery" as never,
						startsAt: new Date().toISOString() as never,
						patientName: null,
					}),
				]}
				patients={[
					{ id: 2, name: null },
					{ id: 3, name: "v1.ciphertext" },
				]}
				api={api()}
			/>,
		);
		expect(screen.getByText("mystery")).toBeTruthy();
		expect(screen.getByText("#1")).toBeTruthy();
		// Patient-option labels (dialog select) cover the null and
		// locked-name branches of patientLabel.
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		expect(screen.getByText("#2")).toBeTruthy();
		expect(screen.getByText("Locked record")).toBeTruthy();
	});

	it("portal page tolerates a pathname without an instance segment", () => {
		routerMocks.pathname = "/portal";
		render(<AgendaPortalPage data={null} ctx={{ plugins: [], locale: "en" } as never} />);
		expect(screen.getByText("No appointments in this period.")).toBeTruthy();
	});

	it("the create dialog ignores an empty patient and surfaces a denied submit", async () => {
		const a = {
			...api(),
			create: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: false })),
		};
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		// No patient picked — the submit guard returns before any api call.
		fireEvent.click(screen.getByText("Save"));
		expect(a.create).not.toHaveBeenCalled();
		// Pick a patient; the denied create keeps the dialog open with the error copy.
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(a.create).toHaveBeenCalled());
		await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
	});

	it("the create dialog names a double-booking instead of the generic error", async () => {
		const a = {
			...api(),
			create: vi.fn<() => Promise<AppointmentWriteResult>>(async () => ({
				ok: false,
				reason: "conflict",
			})),
		};
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={a} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(screen.getByRole("alert").textContent).toBe("This time overlaps another appointment."),
		);
	});

	it("the edit dialog closes via cancel", async () => {
		render(
			<AgendaPage appointments={[appt({})]} patients={[{ id: 1, name: "Ana" }]} api={api()} />,
		);
		fireEvent.click(screen.getByLabelText("Edit"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		const dialog = screen.getByRole("dialog");
		fireEvent.click(within(dialog).getByText("Cancel"));
		await waitFor(() => expect(screen.queryByText("Save")).toBeNull());
	});

	it("the create dialog closes on Escape via onOpenChange", async () => {
		render(<AgendaPage appointments={[]} patients={[{ id: 1, name: "Ana" }]} api={api()} />);
		fireEvent.click(screen.getByText("New appointment"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		fireEvent.keyDown(document.body, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("Save")).toBeNull());
	});

	it("the edit dialog flags an invalid date and a denied submit", async () => {
		const a = {
			...api(),
			update: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({ ok: false })),
		};
		render(
			<AgendaPage
				appointments={[appt({ note: "old" })]}
				patients={[
					{ id: 1, name: "Ana" },
					{ id: 2, name: "Bia" },
				]}
				api={a}
			/>,
		);
		fireEvent.click(screen.getByLabelText("Edit"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		const date = document.getElementById("appointment-date")!;
		const time = document.getElementById("appointment-time")!;
		const duration = document.getElementById("appointment-duration")!;
		const note = document.getElementById("appointment-note")!;
		// Clearing the date makes the composed start instant invalid.
		fireEvent.change(date, { target: { value: "" } });
		fireEvent.change(time, { target: { value: "09:30" } });
		fireEvent.change(duration, { target: { value: "45" } });
		fireEvent.change(note, { target: { value: "new note" } });
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() => expect(screen.getByText("Required")).toBeTruthy());
		expect(a.update).not.toHaveBeenCalled();
		// Restore a valid date — the denied submit then exercises the
		// !ok -> failed path inside the dialog.
		fireEvent.change(date, { target: { value: "2030-01-15" } });
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(a.update).toHaveBeenCalledWith(
				1,
				expect.objectContaining({ note: "new note", durationMin: 45 }),
			),
		);
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
	});
});

describe("AgendaPage calendar views (T-259)", () => {
	type ListFn = NonNullable<AgendaApi["list"]>;
	const tab = (name: string) => screen.getByRole("tab", { name });
	/** Today at hh:mm, local time. */
	const todayAt = (h: number, m = 0) => {
		const d = new Date();
		d.setHours(h, m, 0, 0);
		return d;
	};

	it("switches between list, week and month with matching navigation", () => {
		render(<AgendaPage appointments={[]} patients={[]} api={api()} />);
		expect(tab("List").getAttribute("aria-selected")).toBe("true");
		fireEvent.click(tab("Week"));
		expect(tab("Week").getAttribute("aria-selected")).toBe("true");
		expect(screen.getAllByLabelText("New appointment at 09:00").length).toBe(7);
		const weekLabel = screen.getByTestId("range-label").textContent;
		fireEvent.click(screen.getByLabelText("Next week"));
		expect(screen.getByTestId("range-label").textContent).not.toBe(weekLabel);
		fireEvent.click(tab("Month"));
		expect(document.querySelectorAll("[data-day]").length).toBe(42);
		fireEvent.click(screen.getByText("Today"));
		const monthLabel = screen.getByTestId("range-label").textContent;
		fireEvent.click(screen.getByLabelText("Next month"));
		expect(screen.getByTestId("range-label").textContent).not.toBe(monthLabel);
		fireEvent.click(screen.getByLabelText("Previous month"));
		fireEvent.click(screen.getByText("Today"));
		expect(screen.getByTestId("range-label").textContent).toBe(monthLabel);
	});

	it("clicking an empty week slot opens a new appointment prefilled at that time", async () => {
		const a = api();
		render(
			<AgendaPage
				appointments={[]}
				patients={[{ id: 1, name: "Ana" }]}
				api={a}
				initialView="week"
			/>,
		);
		const today = todayAt(0);
		const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
		const column = document.querySelector(`[data-day="${key}"]`) as HTMLElement;
		fireEvent.click(within(column).getByLabelText("New appointment at 14:30"));
		await waitFor(() => expect(screen.getByText("Save")).toBeTruthy());
		expect((screen.getByLabelText("Date") as HTMLInputElement).value).toBe(key);
		expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("14:30");
		fireEvent.click(screen.getByText("Ana"));
		fireEvent.click(screen.getByText("Save"));
		await waitFor(() =>
			expect(a.create).toHaveBeenCalledWith(expect.objectContaining({ startsAt: todayAt(14, 30) })),
		);
	});

	it("a week block opens the details dialog with the appointment's actions", async () => {
		const a = api();
		const row = appt({ id: 7, patientName: "Bia", startsAt: todayAt(23, 0) });
		render(<AgendaPage appointments={[row]} patients={[]} api={a} initialView="week" />);
		fireEvent.click(screen.getByRole("button", { name: "23:00 Bia" }));
		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).getByText(/Appointment ·/)).toBeTruthy();
		fireEvent.click(within(dialog).getByText("Confirm"));
		await waitFor(() => expect(a.setStatus).toHaveBeenCalledWith(7, "confirmed"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("the details dialog closes on Escape", async () => {
		const row = appt({ id: 7, patientName: "Bia", startsAt: todayAt(23, 0) });
		render(<AgendaPage appointments={[row]} patients={[]} api={api()} initialView="week" />);
		fireEvent.click(screen.getByRole("button", { name: "23:00 Bia" }));
		await screen.findByRole("dialog");
		fireEvent.keyDown(document.body, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
	});

	it("editing from the details dialog swaps it for the edit form", async () => {
		const row = appt({ id: 7, patientName: "Bia", startsAt: todayAt(23, 0) });
		render(
			<AgendaPage
				appointments={[row]}
				patients={[{ id: 1, name: "Bia" }]}
				api={api()}
				initialView="week"
			/>,
		);
		fireEvent.click(screen.getByRole("button", { name: "23:00 Bia" }));
		const dialog = await screen.findByRole("dialog");
		fireEvent.click(within(dialog).getByLabelText("Edit"));
		await waitFor(() => expect(screen.queryByText(/Appointment ·/)).toBeNull());
		expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("23:00");
	});

	it("the list orders a day's appointments by time whatever the loader order", () => {
		render(
			<AgendaPage
				appointments={[
					appt({ id: 2, patientName: "Late", startsAt: todayAt(23, 30) }),
					appt({ id: 1, patientName: "Early", startsAt: todayAt(23, 0) }),
				]}
				patients={[]}
				api={api()}
			/>,
		);
		const text = document.body.textContent ?? "";
		expect(text.indexOf("Early")).toBeLessThan(text.indexOf("Late"));
	});

	it("picking a month day opens that day's week", () => {
		render(<AgendaPage appointments={[]} patients={[]} api={api()} initialView="month" />);
		const cells = document.querySelectorAll("[data-day]");
		fireEvent.click(cells[cells.length - 1]!);
		expect(tab("Week").getAttribute("aria-selected")).toBe("true");
		const last = cells[cells.length - 1]!.getAttribute("data-day");
		expect(document.querySelector(`[data-day="${last}"]`)).toBeTruthy();
	});

	it("fetches ranges outside the loader window and refetches after a change", async () => {
		const far = new Date();
		far.setMonth(far.getMonth() + 3, 15);
		far.setHours(10, 0, 0, 0);
		const list = vi.fn<ListFn>(async () => ({
			ok: true,
			appointments: [appt({ id: 99, patientName: "Far", startsAt: far })],
		}));
		const a = { ...api(), list };
		render(<AgendaPage appointments={[]} patients={[]} api={a} initialView="month" />);
		// The 6-week grid already spills past the loader window.
		await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
		for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByLabelText("Next month"));
		await screen.findByText("Far");
		const [from, to] = list.mock.calls.at(-1)!;
		expect(to.getTime() - from.getTime()).toBe(42 * 86_400_000);
		const calls = list.mock.calls.length;
		// A status change from the week view refetches the visible range.
		fireEvent.click(screen.getByText("Far").closest("button")!);
		fireEvent.click(await screen.findByRole("button", { name: "10:00 Far" }));
		fireEvent.click(within(await screen.findByRole("dialog")).getByText("Confirm"));
		await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
	});

	it("keeps showing loader rows when a range fetch fails or no list api is wired", async () => {
		const list = vi
			.fn<ListFn>(async () => ({ ok: false }))
			.mockResolvedValueOnce({ ok: false })
			.mockRejectedValueOnce(new Error("network"));
		const row = appt({ id: 3, patientName: "Near", startsAt: todayAt(23, 30) });
		render(
			<AgendaPage
				appointments={[row]}
				patients={[]}
				api={{ ...api(), list }}
				initialView="month"
			/>,
		);
		await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
		fireEvent.click(screen.getByLabelText("Next month"));
		await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		fireEvent.click(screen.getByLabelText("Previous month"));
		expect(screen.getByText("Near")).toBeTruthy();
		cleanup();
		render(<AgendaPage appointments={[row]} patients={[]} api={api()} initialView="month" />);
		expect(screen.getByText("Near")).toBeTruthy();
	});
});

describe("AgendaPortalPage", () => {
	it("unwraps loader data and wires the doctor portal base", () => {
		render(
			<AgendaPortalPage
				data={{
					appointments: [appt({})],
					patients: [{ id: 1, name: "Ana" }],
				}}
				ctx={{ plugins: [], locale: "en" } as never}
			/>,
		);
		expect(screen.getByText("Ana")).toBeTruthy();
	});

	it("tolerates a null loader payload", () => {
		render(<AgendaPortalPage data={null} ctx={{ plugins: [], locale: "en" } as never} />);
		expect(screen.getByText("No appointments in this period.")).toBeTruthy();
	});

	it("wires router invalidate on change and consultation navigation on start", async () => {
		render(
			<AgendaPortalPage
				data={{ appointments: [appt({})], patients: [] }}
				ctx={{ plugins: [], locale: "en" } as never}
			/>,
		);
		fireEvent.click(screen.getByText("Confirm"));
		await waitFor(() => expect(agendaApiMocks.setStatus).toHaveBeenCalledWith(1, "confirmed"));
		await waitFor(() => expect(routerMocks.invalidate).toHaveBeenCalled());
		fireEvent.click(screen.getByText("Start consult"));
		await waitFor(() => expect(agendaApiMocks.start).toHaveBeenCalledWith(1));
		await waitFor(() =>
			expect(routerMocks.navigate).toHaveBeenCalledWith({
				to: "/portal/doctor/consultations/42/record",
			}),
		);
	});
});
