// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { agendaMessages } from "../i18n.ts";
import type { AgendaListItem } from "./AgendaPage.tsx";
import { layoutDay, MonthGrid, monthGridDays, visibleHours, WeekGrid } from "./-calendar.tsx";

const t = agendaMessages("en");

const appt = (over: Partial<AgendaListItem>): AgendaListItem => ({
	id: 1,
	patientId: 1,
	patientName: "Ana",
	status: "scheduled",
	startsAt: new Date(2030, 0, 7, 9, 0),
	durationMin: 30,
	consultationId: null,
	note: null,
	reminderSentAt: null,
	...over,
});

/** Mon 7 Jan 2030 … Sun 13 Jan 2030. */
const WEEK = Array.from({ length: 7 }, (_, i) => new Date(2030, 0, 7 + i));

afterEach(cleanup);

describe("layoutDay", () => {
	it("puts overlapping blocks side by side and reuses freed lanes", () => {
		const placed = layoutDay([
			appt({ id: 2, startsAt: new Date(2030, 0, 7, 9, 15) }),
			appt({ id: 1, startsAt: new Date(2030, 0, 7, 9, 0) }),
			// Starts when #1 ends: same cluster (overlaps #2), reuses lane 0.
			appt({ id: 3, startsAt: new Date(2030, 0, 7, 9, 30) }),
			// Alone after the cluster ends.
			appt({ id: 4, startsAt: new Date(2030, 0, 7, 11, 0) }),
		]);
		const byId = Object.fromEntries(placed.map((p) => [p.a.id, p]));
		expect(byId[1]).toMatchObject({ lane: 0, lanes: 2 });
		expect(byId[2]).toMatchObject({ lane: 1, lanes: 2 });
		expect(byId[3]).toMatchObject({ lane: 0, lanes: 2 });
		expect(byId[4]).toMatchObject({ lane: 0, lanes: 1 });
	});
});

describe("visibleHours", () => {
	it("defaults to 07–20 and widens to fit early, late and overnight blocks", () => {
		expect(visibleHours([])).toEqual({ from: 7, to: 20 });
		expect(visibleHours([appt({ startsAt: new Date(2030, 0, 7, 6, 30) })])).toEqual({
			from: 6,
			to: 20,
		});
		// Ends 21:15 → the 21h row is needed; ending exactly 21:00 is not.
		expect(
			visibleHours([appt({ startsAt: new Date(2030, 0, 7, 20, 45), durationMin: 30 })]),
		).toEqual({ from: 7, to: 22 });
		expect(
			visibleHours([appt({ startsAt: new Date(2030, 0, 7, 20, 0), durationMin: 60 })]),
		).toEqual({ from: 7, to: 21 });
		expect(
			visibleHours([appt({ startsAt: new Date(2030, 0, 7, 23, 30), durationMin: 60 })]),
		).toEqual({ from: 7, to: 24 });
	});
});

describe("WeekGrid", () => {
	const renderWeek = (items: AgendaListItem[], now = new Date(2030, 0, 8, 10, 0).getTime()) => {
		const onSelect = vi.fn<(a: AgendaListItem) => void>();
		const onCreateAt = vi.fn<(d: Date) => void>();
		render(
			<WeekGrid
				days={WEEK}
				items={items}
				t={t}
				locale="en"
				now={now}
				onSelect={onSelect}
				onCreateAt={onCreateAt}
			/>,
		);
		return { onSelect, onCreateAt };
	};

	it("renders blocks that open their appointment", () => {
		const a = appt({ id: 5, patientName: "Bia", startsAt: new Date(2030, 0, 9, 14, 30) });
		const { onSelect } = renderWeek([a]);
		fireEvent.click(screen.getByRole("button", { name: "14:30 Bia" }));
		expect(onSelect).toHaveBeenCalledWith(a);
	});

	it("books an empty slot at its exact day and time", () => {
		const { onCreateAt } = renderWeek([]);
		const tuesday = document.querySelector('[data-day="2030-01-08"]') as HTMLElement;
		const slot = Array.from(tuesday.querySelectorAll("button")).find(
			(b) => b.getAttribute("aria-label") === "New appointment at 09:30",
		)!;
		fireEvent.click(slot);
		expect(onCreateAt).toHaveBeenCalledWith(new Date(2030, 0, 8, 9, 30));
	});

	it("dims terminal appointments and labels locked names", () => {
		renderWeek([
			appt({ id: 1, status: "cancelled", patientName: "Ana" }),
			appt({ id: 2, status: "weird", patientName: "v1.cipher", startsAt: new Date(2030, 0, 8, 9) }),
		]);
		expect(screen.getByRole("button", { name: "09:00 Ana" }).className).toContain("line-through");
		expect(screen.getByRole("button", { name: "09:00 Locked record" })).toBeTruthy();
	});

	it("draws the now-line only on today's column, inside the visible hours", () => {
		renderWeek([]);
		const line = screen.getByTestId("now-line");
		expect(line.closest("[data-day]")?.getAttribute("data-day")).toBe("2030-01-08");
		cleanup();
		// 05:00 is before the grid starts — no line.
		renderWeek([], new Date(2030, 0, 8, 5, 0).getTime());
		expect(screen.queryByTestId("now-line")).toBeNull();
		cleanup();
		// A week that does not contain today — no line.
		renderWeek([], new Date(2031, 0, 8, 10, 0).getTime());
		expect(screen.queryByTestId("now-line")).toBeNull();
	});
});

describe("MonthGrid", () => {
	const JAN = new Date(2030, 0, 1);

	it("covers six Monday-first weeks around the month", () => {
		const days = monthGridDays(JAN);
		expect(days).toHaveLength(42);
		// 1 Jan 2030 is a Tuesday → the grid opens on Mon 31 Dec 2029.
		expect(days[0]).toEqual(new Date(2029, 11, 31));
	});

	it("lists up to three appointments per day, then +N more, sorted by time", () => {
		const at = (h: number, id: number) =>
			appt({ id, patientName: `P${id}`, startsAt: new Date(2030, 0, 9, h) });
		render(
			<MonthGrid
				month={JAN}
				items={[at(12, 3), at(8, 1), at(9, 2), at(15, 4), at(16, 5)]}
				t={t}
				locale="en"
				now={new Date(2030, 0, 9).getTime()}
				onPickDay={() => {}}
			/>,
		);
		const cell = document.querySelector('[data-day="2030-01-09"]') as HTMLElement;
		expect(cell.textContent).toContain("08:00 P1");
		expect(cell.textContent).toContain("12:00 P3");
		expect(cell.textContent).not.toContain("P4");
		expect(cell.textContent).toContain("+2 more");
		// Today's number is highlighted.
		expect(cell.querySelector(".bg-primary")?.textContent).toBe("9");
	});

	it("mutes days outside the month, strikes terminal rows and hands back the picked day", () => {
		const onPickDay = vi.fn<(d: Date) => void>();
		render(
			<MonthGrid
				month={JAN}
				items={[appt({ status: "no_show", startsAt: new Date(2030, 0, 7, 9) })]}
				t={t}
				locale="en"
				now={new Date(2031, 0, 1).getTime()}
				onPickDay={onPickDay}
			/>,
		);
		const outside = document.querySelector('[data-day="2029-12-31"]') as HTMLElement;
		expect(outside.className).toContain("bg-muted/40");
		const day7 = document.querySelector('[data-day="2030-01-07"]') as HTMLElement;
		expect(day7.querySelector(".line-through")).toBeTruthy();
		fireEvent.click(day7);
		expect(onPickDay).toHaveBeenCalledWith(new Date(2030, 0, 7));
	});
});
