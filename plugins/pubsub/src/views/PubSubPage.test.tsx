// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const publishPubSubMessageFn = vi.fn<
	(_arg?: { data?: { topicId: string; payload: unknown } }) => Promise<{ ok: boolean }>
>(async () => ({ ok: true }));
vi.mock("../fns.ts", () => ({
	publishPubSubMessageFn: (arg?: { data?: { topicId: string; payload: unknown } }) =>
		publishPubSubMessageFn(arg),
}));

import type { PubSubTopicInfo, PubSubTopicsResult } from "@ktb/server-fns";

import { PubSubPage } from "./PubSubPage.tsx";

const topic = (over: Partial<PubSubTopicInfo> = {}): PubSubTopicInfo => ({
	id: "memory:cron.fires",
	name: "cron.fires",
	transport: "in-process",
	subscribers: 1,
	recent: [{ at: 1700000000000, payload: { jobId: "agenda-reminders", ok: true } }],
	...over,
});

const listing = (topics: PubSubTopicInfo[], degraded: string[] = []): PubSubTopicsResult => ({
	topics,
	degraded,
});

const openTab = (name: string) => {
	fireEvent.click(screen.getByRole("tab", { name }));
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("PubSubPage", () => {
	it("renders the topics table with data", () => {
		render(<PubSubPage listing={listing([topic()])} locale="en" />);
		expect(screen.getByRole("heading", { name: "Pub/sub" })).toBeTruthy();
		expect(screen.getByText("cron.fires")).toBeTruthy();
		expect(screen.getByText("memory:cron.fires")).toBeTruthy();
		expect(screen.getByText("in-process")).toBeTruthy();
		// subscribers=1 and recent count=1 — both render as "1".
		expect(screen.getAllByText("1").length).toBeGreaterThanOrEqual(2);
	});

	it("renders honest states for null subscribers, missing history and empty topics", () => {
		render(
			<PubSubPage
				listing={listing([
					topic({
						id: "redis:ktb:events",
						name: "ktb:events",
						transport: "redis",
						subscribers: null,
						recent: undefined,
					}),
				])}
				locale="en"
			/>,
		);
		// Redis topics show dashes, never fabricated counts.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("renders a degraded-source banner naming the failed transports", () => {
		render(<PubSubPage listing={listing([], ["redis"])} locale="en" />);
		expect(screen.getByText("Degraded sources")).toBeTruthy();
		expect(screen.getByText(/redis could not be read/)).toBeTruthy();
	});

	it("renders declared topics and hides the section when empty or absent", () => {
		// Absent (default null) and empty declarations render nothing.
		const { unmount } = render(<PubSubPage listing={listing([])} locale="en" />);
		expect(screen.queryByText("Declared topics")).toBeNull();
		unmount();
		render(<PubSubPage listing={listing([])} declared={[]} locale="en" />);
		expect(screen.queryByText("Declared topics")).toBeNull();
		cleanup();

		render(
			<PubSubPage
				listing={listing([])}
				declared={[
					{
						topic: "cron.fires",
						pluginId: "cron.services",
						description: "Cron job firings",
					},
					{ topic: "jobs.ping" },
				]}
				locale="en"
			/>,
		);
		expect(screen.getByText("Declared topics")).toBeTruthy();
		expect(screen.getByText("cron.fires")).toBeTruthy();
		expect(screen.getByText("cron.services")).toBeTruthy();
		expect(screen.getByText("Cron job firings")).toBeTruthy();
		// Missing pluginId/description degrade to the dash marker.
		expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
	});

	it("renders unavailable and empty states", () => {
		const { unmount } = render(<PubSubPage listing={null} locale="en" />);
		expect(screen.getByText("Signal unavailable")).toBeTruthy();
		unmount();
		render(<PubSubPage listing={listing([])} locale="en" />);
		expect(screen.getByText(/No topics yet/)).toBeTruthy();
	});

	it("publishes a valid JSON payload", async () => {
		publishPubSubMessageFn.mockResolvedValueOnce({ ok: true } as never);
		render(<PubSubPage listing={listing([topic()])} locale="en" />);
		openTab("Publish");
		fireEvent.change(screen.getByPlaceholderText("memory:cron.fires"), {
			target: { value: "memory:cron.fires" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(publishPubSubMessageFn).toHaveBeenCalledWith({
			data: { topicId: "memory:cron.fires", payload: { hello: "world" } },
		});
		expect(await screen.findByText("Message published.")).toBeTruthy();
	});

	it("rejects invalid JSON without calling the server fn", async () => {
		render(<PubSubPage listing={listing([topic()])} locale="en" />);
		openTab("Publish");
		fireEvent.change(screen.getByPlaceholderText("memory:cron.fires"), {
			target: { value: "memory:x" },
		});
		const area = document.querySelector("textarea")!;
		fireEvent.change(area, { target: { value: "{not json" } });
		fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		expect(await screen.findByText("Payload is not valid JSON.")).toBeTruthy();
		expect(publishPubSubMessageFn).not.toHaveBeenCalled();
	});

	it("renders empty history and unknown last activity honestly", () => {
		render(
			<PubSubPage
				listing={listing([
					topic({
						id: "memory:empty",
						name: "empty-topic",
						subscribers: 2,
						recent: [],
					}),
					topic({
						id: "memory:untimed",
						name: "untimed-topic",
						recent: [{ at: undefined as unknown as number, payload: {} }],
					}),
				])}
				locale="en"
			/>,
		);
		// An empty retained history reports no messages and no activity.
		expect(screen.getByText("No history")).toBeTruthy();
		expect(screen.getByText("Never")).toBeTruthy();
		// An undefined timestamp degrades to the unknown marker.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("surfaces every publish outcome, including transport rejections", async () => {
		publishPubSubMessageFn
			.mockResolvedValueOnce({ ok: false, reason: "unknown-topic" } as never)
			.mockResolvedValueOnce({ ok: false, reason: "unavailable" } as never)
			.mockResolvedValueOnce({ ok: false, reason: "forbidden" } as never)
			.mockRejectedValueOnce(new Error("transport gone"))
			.mockResolvedValueOnce({ ok: false, reason: "publish-failed" } as never);
		render(<PubSubPage listing={listing([topic()])} locale="en" />);
		openTab("Publish");
		fireEvent.change(screen.getByPlaceholderText("memory:cron.fires"), {
			target: { value: "memory:cron.fires" },
		});
		const publish = () => fireEvent.click(screen.getByRole("button", { name: "Publish" }));
		publish();
		expect(
			await screen.findByText("Unknown topic id — pick one from the Topics tab."),
		).toBeTruthy();
		publish();
		expect(
			await screen.findByText("Pub/sub transport unavailable in this environment."),
		).toBeTruthy();
		publish();
		expect(await screen.findByText("Not permitted.")).toBeTruthy();
		publish();
		// A rejected wire call collapses to the generic failure copy.
		expect(await screen.findByText("Publish failed.")).toBeTruthy();
		publish();
		// publish-failed maps to the same copy — the pending state clears the
		// previous message first, so this only resolves once it lands.
		expect(await screen.findByText("Publish failed.")).toBeTruthy();
		expect(publishPubSubMessageFn).toHaveBeenCalledTimes(5);
	});
});
