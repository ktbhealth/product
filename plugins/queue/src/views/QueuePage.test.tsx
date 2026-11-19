// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const enqueueJobFn = vi.fn<
	(_arg?: { data?: { kind: string; payload: unknown } }) => Promise<{ ok: boolean }>
>(async (_arg) => ({
	ok: true,
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
		openTab("Enqueue test job");
		expect(screen.getByText("No job kinds registered.")).toBeTruthy();
	});

	it("renders null depth as a dash, not a fabricated zero", () => {
		render(
			<QueuePage queues={[queue({ depth: null })]} runs={[]} kinds={["jobs.ping"]} locale="en" />,
		);
		// depth cells render "—" for all four counters
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(4);
	});

	it("renders every transport and consumer label", () => {
		render(
			<QueuePage
				queues={[
					queue({
						id: "cf",
						name: "cf-q",
						transport: "cloudflare-queue",
						consumer: "in-app",
					}),
					queue({ id: "sq", name: "sq-q", transport: "sqlite", consumer: "external" }),
					queue({ id: "uk", name: "uk-q", transport: "unknown", consumer: "none" }),
				]}
				runs={[]}
				kinds={["jobs.ping"]}
				locale="en"
			/>,
		);
		expect(screen.getByText("Cloudflare Queue")).toBeTruthy();
		expect(screen.getByText("SQLite (dev)")).toBeTruthy();
		expect(screen.getByText("Unknown")).toBeTruthy();
		expect(screen.getByText("In-app worker")).toBeTruthy();
		expect(screen.getByText("External")).toBeTruthy();
		expect(screen.getByText("None")).toBeTruthy();
	});

	it("filters runs by kind and status, deriving kind options when kinds is null", () => {
		render(
			<QueuePage
				queues={[]}
				runs={[
					run({
						id: "aaaa1111-0000",
						kind: "jobs.ping",
						status: "done",
						error: "boom",
						payloadRef: "payloads/r1.json",
					}),
					run({
						id: "bbbb2222-0000",
						kind: "audio.transcribe",
						status: "failed",
						// nullish timestamp → fmt renders a dash, never crashes.
						createdAt: null as unknown as number,
					}),
				]}
				kinds={null}
				locale="en"
			/>,
		);
		openTab("Job runs");
		// kind options derived from the runs themselves when kinds is null.
		expect(screen.getByRole("option", { name: "audio.transcribe" })).toBeTruthy();
		expect(screen.getByText("aaaa1111")).toBeTruthy();
		expect(screen.getByText("boom")).toBeTruthy();
		expect(screen.getByText("payloads/r1.json")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Filter by kind"), {
			target: { value: "audio.transcribe" },
		});
		expect(screen.queryByText("aaaa1111")).toBeNull();
		expect(screen.getByText("bbbb2222")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Filter by status"), {
			target: { value: "queued" },
		});
		expect(screen.getByText("No runs match the filters.")).toBeTruthy();
		fireEvent.change(screen.getByLabelText("Filter by status"), {
			target: { value: "failed" },
		});
		expect(screen.getByText("bbbb2222")).toBeTruthy();
		// null error / payloadRef / createdAt all render as dashes.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(3);
	});

	it("enqueues with an empty payload defaulting to {}", async () => {
		render(<QueuePage queues={[]} runs={[]} kinds={["jobs.ping"]} locale="en" />);
		openTab("Enqueue test job");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "jobs.ping" } });
		fireEvent.click(screen.getByRole("button", { name: "Enqueue" }));
		expect(await screen.findByText("Job enqueued.")).toBeTruthy();
		expect(enqueueJobFn).toHaveBeenCalledWith({
			data: { kind: "jobs.ping", payload: {} },
		});
	});

	it("enqueues a parsed JSON payload and disables submit while pending", async () => {
		let resolveEnqueue!: (value: { ok: boolean }) => void;
		enqueueJobFn.mockImplementationOnce(
			() =>
				new Promise<{ ok: boolean }>((resolve) => {
					resolveEnqueue = resolve;
				}),
		);
		render(<QueuePage queues={[]} runs={[]} kinds={["jobs.ping"]} locale="en" />);
		openTab("Enqueue test job");
		const submit = screen.getByRole("button", { name: "Enqueue" }) as HTMLButtonElement;
		expect(submit.disabled).toBe(true);
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "jobs.ping" } });
		expect(submit.disabled).toBe(false);
		fireEvent.change(screen.getByPlaceholderText('{"key": "value"}'), {
			target: { value: '{"a":1}' },
		});
		fireEvent.click(submit);
		await waitFor(() => expect(submit.disabled).toBe(true));
		resolveEnqueue({ ok: true });
		expect(await screen.findByText("Job enqueued.")).toBeTruthy();
		expect(enqueueJobFn).toHaveBeenCalledWith({
			data: { kind: "jobs.ping", payload: { a: 1 } },
		});
	});

	it("rejects invalid JSON without calling the server fn", async () => {
		render(<QueuePage queues={[]} runs={[]} kinds={["jobs.ping"]} locale="en" />);
		openTab("Enqueue test job");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "jobs.ping" } });
		fireEvent.change(screen.getByPlaceholderText('{"key": "value"}'), {
			target: { value: "{not json" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Enqueue" }));
		expect(await screen.findByText("Payload is not valid JSON.")).toBeTruthy();
		expect(enqueueJobFn).not.toHaveBeenCalled();
	});

	it("reports a failed result and a throwing transport as enqueue errors", async () => {
		enqueueJobFn
			.mockResolvedValueOnce({ ok: false })
			.mockRejectedValueOnce(new Error("transport down"));
		render(<QueuePage queues={[]} runs={[]} kinds={["jobs.ping"]} locale="en" />);
		openTab("Enqueue test job");
		fireEvent.change(screen.getByRole("combobox"), { target: { value: "jobs.ping" } });
		fireEvent.click(screen.getByRole("button", { name: "Enqueue" }));
		expect(await screen.findByText("Enqueue failed — the job could not be sent.")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Enqueue" }));
		await waitFor(() => expect(enqueueJobFn).toHaveBeenCalledTimes(2));
		expect(screen.getByText("Enqueue failed — the job could not be sent.")).toBeTruthy();
	});
});
