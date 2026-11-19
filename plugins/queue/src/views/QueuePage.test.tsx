// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const enqueueJobFn = vi.fn<
	(_arg?: { data?: { kind: string; payload: unknown } }) => Promise<{ ok: true }>
>(async (_arg) => ({
	ok: true as const,
}));
vi.mock("../fns.ts", () => ({
	enqueueJobFn: (arg?: { data?: { kind: string; payload: unknown } }) => enqueueJobFn(arg),
}));

import type { JobRecord } from "@ktb/jobs-port";
import type { QueueInfo } from "@ktb/server-fns";

import { QueuePage } from "./QueuePage.tsx";

const queue = (over: Partial<QueueInfo> = {}): QueueInfo => ({
	id: "jobs",
	name: "ktb:jobs",
	transport: "redis",
	consumer: "jobs-worker",
	depth: { pending: 2, processing: 1, done: 40, failed: 3 },
	...over,
});

const openTab = (name: string) => {
	fireEvent.click(screen.getByRole("tab", { name }));
};

const run = (over: Partial<JobRecord> = {}): JobRecord => ({
	id: "run-1",
	kind: "jobs.ping",
	status: "done",
	payloadRef: null,
	error: null,
	tenantId: null,
	createdAt: 1700000000000,
	updatedAt: 1700000001000,
	...over,
});

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("QueuePage", () => {
	it("renders all three sections with data", () => {
		render(<QueuePage queues={[queue()]} runs={[run()]} kinds={["jobs.ping"]} locale="en" />);
		expect(screen.getByRole("heading", { name: "Queue" })).toBeTruthy();
		expect(screen.getAllByText("Bound queues").length).toBeGreaterThan(0);
		expect(screen.getByText("ktb:jobs")).toBeTruthy();
		expect(screen.getByText("Redis")).toBeTruthy();
		openTab("Job runs");
		expect(screen.getAllByText("jobs.ping").length).toBeGreaterThan(0);
		openTab("Enqueue test job");
		expect(screen.getByText("Send a job envelope", { exact: false })).toBeTruthy();
	});

	it("renders unavailable states for null signals", () => {
		render(<QueuePage queues={null} runs={null} kinds={null} locale="en" />);
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
		openTab("Job runs");
		expect(screen.getAllByText("Signal unavailable").length).toBeGreaterThan(0);
		openTab("Enqueue test job");
		expect(screen.getAllByText(/cannot be read/).length).toBeGreaterThan(0);
	});

	it("renders honest empty states", () => {
		render(<QueuePage queues={[]} runs={[]} kinds={[]} locale="en" />);
		expect(screen.getByText(/No queues bound/)).toBeTruthy();
		openTab("Job runs");
		expect(screen.getByText(/No job runs/)).toBeTruthy();
	});

	it("renders null depth as a dash, not a fabricated zero", () => {
		render(
			<QueuePage queues={[queue({ depth: null })]} runs={[]} kinds={["jobs.ping"]} locale="en" />,
		);
		// depth cells render "—" for all four counters
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
	});
});
