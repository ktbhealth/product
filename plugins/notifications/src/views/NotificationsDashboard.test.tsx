// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
	NotificationsDataContext,
	NotificationsUnreadContext,
	type ConsoleNotification,
} from "../context.ts";
import { NotificationsDashboardSections } from "./NotificationsDashboard.tsx";

const rows: ConsoleNotification[] = [
	{ id: "1", title: "Patient created", description: "Ana", read: false },
	{ id: "2", title: "Consultation done", read: true },
];

const renderCard = (notifications: readonly ConsoleNotification[] = rows, unread?: number) =>
	render(
		<NotificationsDataContext.Provider value={notifications}>
			<NotificationsUnreadContext.Provider value={unread}>
				<NotificationsDashboardSections locale="en" />
			</NotificationsUnreadContext.Provider>
		</NotificationsDataContext.Provider>,
	);

afterEach(cleanup);

describe("NotificationsDashboardSections", () => {
	it("renders the console-activity card with the exact unread count", () => {
		// The feed only carries one unread row, but the capped feed cannot
		// be counted — the host-provided exact count wins.
		renderCard(rows, 7);
		expect(screen.getByText("Console activity")).toBeTruthy();
		expect(screen.getByText("Unread notifications")).toBeTruthy();
		expect(screen.getByText("7")).toBeTruthy();
		expect(screen.getByText("Patient created")).toBeTruthy();
		expect(screen.getByText("Consultation done")).toBeTruthy();
	});

	it("falls back to counting unread rows when no exact count is provided", () => {
		renderCard(rows, undefined);
		expect(screen.getByText("1")).toBeTruthy();
	});

	it("renders the empty state when there are no notifications", () => {
		renderCard([], 0);
		expect(screen.getByText("No notifications yet.")).toBeTruthy();
	});
});
