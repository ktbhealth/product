// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	Transcriber,
	TranscriptionBackend,
	TranscriptionEngineMessage,
	TranscriptionStatus,
	TranscriptEvent,
} from "@ktb/transcription";

import { WhisperWarmupCard, WHISPER_WARMUP_DISMISSED_KEY } from "./WhisperWarmupCard.tsx";

const engineSubs = new Set<(m: TranscriptionEngineMessage) => void>();
let statusImpl: () => TranscriptionStatus = () => ({ state: "idle", device: null });
const load = vi.fn();

const backend: TranscriptionBackend = {
	mic: (): Transcriber => ({
		supported: false,
		start: (_cb: (ev: TranscriptEvent) => void) => {},
		stop: () => {},
	}),
	tab: (): Transcriber => ({
		supported: false,
		start: (_cb: (ev: TranscriptEvent) => void) => {},
		stop: () => {},
	}),
	status: () => statusImpl(),
	subscribe: (fn: (m: TranscriptionEngineMessage) => void) => {
		engineSubs.add(fn);
		return () => engineSubs.delete(fn);
	},
	load,
};

const emit = (m: TranscriptionEngineMessage) => {
	act(() => {
		for (const fn of engineSubs) fn(m);
	});
};

const renderCard = (driverId: string | null = "whisper") =>
	render(<WhisperWarmupCard backend={backend} driverId={driverId} />);

beforeEach(() => {
	engineSubs.clear();
	statusImpl = () => ({ state: "idle", device: null });
	load.mockClear();
	window.localStorage.clear();
});

afterEach(cleanup);

describe("WhisperWarmupCard", () => {
	it("renders nothing and never loads when the driver is not whisper", () => {
		const { container } = renderCard("webspeech");
		expect(container.firstChild).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("renders nothing when no transcription driver resolved", () => {
		const { container } = renderCard(null);
		expect(container.firstChild).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("stays hidden when the doctor already dismissed it on this device", () => {
		window.localStorage.setItem(WHISPER_WARMUP_DISMISSED_KEY, "1");
		const { container } = renderCard();
		expect(container.firstChild).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it("mounts the card and kicks backend.load() in the background", () => {
		renderCard();
		expect(screen.getByText("Prepare speech recognition")).toBeTruthy();
		expect(screen.getByText(/first consultation/)).toBeTruthy();
		expect(screen.getByText("Downloading speech model…")).toBeTruthy();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("shows the engine's live download status while loading", () => {
		renderCard();
		emit({ type: "progress", message: "downloading model… 12 MB" });
		expect(screen.getByText("downloading model… 12 MB")).toBeTruthy();
		emit({ type: "progress" });
		expect(screen.getByText("Downloading speech model…")).toBeTruthy();
	});

	it("shows the ready state with the device once the model is loaded", () => {
		renderCard();
		emit({ type: "ready", device: "webgpu" });
		expect(screen.getByText("Speech recognition ready (webgpu)")).toBeTruthy();
	});

	it("reflects an already-ready engine without waiting for a message", () => {
		statusImpl = () => ({ state: "ready", device: "wasm" });
		renderCard();
		expect(screen.getByText("Speech recognition ready (wasm)")).toBeTruthy();
	});

	it("reflects a load already in flight from backend.status()", () => {
		statusImpl = () => ({ state: "loading", device: null });
		renderCard();
		expect(screen.getByText("Downloading speech model…")).toBeTruthy();
	});

	it("ignores per-chunk transcription errors that carry an id", () => {
		renderCard();
		emit({ type: "error", id: "t1", message: "chunk failed" });
		expect(screen.queryByText(/Speech model unavailable/)).toBeNull();
		expect(screen.getByText("Downloading speech model…")).toBeTruthy();
	});

	it("shows engine errors with retry, and retry re-triggers load", async () => {
		const user = userEvent.setup();
		renderCard();
		emit({ type: "load-failed" });
		emit({ type: "error", message: "network down" });
		expect(screen.getByText("Speech model unavailable: network down")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Retry" }));
		expect(load).toHaveBeenCalledTimes(2);
		expect(screen.getByText("Downloading speech model…")).toBeTruthy();
	});

	it("shows the failed state without detail when the error carries none", () => {
		renderCard();
		emit({ type: "error" });
		expect(screen.getByText("Speech model unavailable:")).toBeTruthy();
	});

	it("dismiss hides the card and persists the choice per device", async () => {
		const user = userEvent.setup();
		const { unmount } = renderCard();
		await user.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByText("Prepare speech recognition")).toBeNull();
		expect(window.localStorage.getItem(WHISPER_WARMUP_DISMISSED_KEY)).toBe("1");
		unmount();
		// A fresh mount (next portal visit) stays hidden and never loads.
		const second = renderCard();
		expect(second.container.firstChild).toBeNull();
		expect(load).toHaveBeenCalledTimes(1);
	});

	it("still hides on dismiss when localStorage writes throw", async () => {
		const user = userEvent.setup();
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("quota");
		});
		try {
			renderCard();
			await user.click(screen.getByRole("button", { name: "Dismiss" }));
			expect(screen.queryByText("Prepare speech recognition")).toBeNull();
		} finally {
			setItem.mockRestore();
		}
	});
});
