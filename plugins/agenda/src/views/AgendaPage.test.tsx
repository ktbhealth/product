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
				to: "/portal/doctor/consultations/42",
			}),
		);
	});
});
