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

import type { PubSubTopicInfo } from "@ktb/server-fns";

import { PubSubPage } from "./PubSubPage.tsx";

const topic = (over: Partial<PubSubTopicInfo> = {}): PubSubTopicInfo => ({
	id: "memory:cron.fires",
	name: "cron.fires",
	transport: "in-process",
	subscribers: 1,
	recent: [{ at: 1700000000000, payload: { jobId: "agenda-reminders", ok: true } }],
	...over,
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
		render(<PubSubPage topics={[topic()]} locale="en" />);
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
				topics={[
					topic({
						id: "redis:ktb:events",
						name: "ktb:events",
						transport: "redis",
						subscribers: null,
						recent: undefined,
					}),
				]}
				locale="en"
			/>,
		);
		// Redis topics show dashes, never fabricated counts.
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("renders unavailable and empty states", () => {
		const { unmount } = render(<PubSubPage topics={null} locale="en" />);
		expect(screen.getByText("Signal unavailable")).toBeTruthy();
		unmount();
		render(<PubSubPage topics={[]} locale="en" />);
		expect(screen.getByText(/No topics yet/)).toBeTruthy();
	});

	it("publishes a valid JSON payload", async () => {
		publishPubSubMessageFn.mockResolvedValueOnce({ ok: true } as never);
		render(<PubSubPage topics={[topic()]} locale="en" />);
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
		render(<PubSubPage topics={[topic()]} locale="en" />);
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
});
