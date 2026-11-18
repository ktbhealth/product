// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const routerMocks = vi.hoisted(() => ({
	invalidate: vi.fn<() => Promise<void>>(async () => {}),
	navigate: vi.fn<(opts: unknown) => Promise<void>>(async () => {}),
}));

vi.mock("@tanstack/react-router", () => ({
	Link: ({ to, children }: { to: string; children?: unknown }) => (
		<a href={to}>{children as never}</a>
	),
	useLocation: (opts: { select: (l: { pathname: string }) => unknown }) =>
		opts.select({ pathname: "/portal/doctor/agenda" }),
	useRouter: () => ({
		invalidate: routerMocks.invalidate,
		navigate: routerMocks.navigate,
	}),
}));

import { AgendaPage, AgendaPortalPage, type AgendaListItem } from "./AgendaPage.tsx";

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
});
