// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	AudioTranscriptPanel,
	ConsultationAudioPlayer,
	useConsultationAudio,
	type AudioPipelineInfo,
} from "./-transcript.tsx";
import type { TranscriptSegment } from "../segments.ts";

type Detail = AudioPipelineInfo;

const POLL = 3000;
const flush = (ms = POLL) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

describe("useConsultationAudio", () => {
	it("does nothing without a fetcher or a consultation id", async () => {
		const fetcher = vi.fn();
		const { result: noFetcher } = renderHook(() => useConsultationAudio(undefined, 1));
		const { result: noId } = renderHook(() => useConsultationAudio(fetcher, null));
		await flush();
		expect(noFetcher.current).toBeNull();
		expect(noId.current).toBeNull();
		expect(fetcher).not.toHaveBeenCalled();
	});

	it("keeps polling while the pipeline is in flight and stops once it is terminal", async () => {
		const fetcher = vi
			.fn<(i: { data: number }) => Promise<Detail | null>>()
			.mockResolvedValueOnce({ audioStatus: "queued" })
			.mockResolvedValueOnce({ audioStatus: "processing" })
			.mockResolvedValue({ audioStatus: "failed" });
		const { result } = renderHook(() => useConsultationAudio(fetcher, 7));
		await flush(0);
		expect(result.current?.audioStatus).toBe("queued");
		await flush();
		expect(result.current?.audioStatus).toBe("processing");
		await flush();
		expect(result.current?.audioStatus).toBe("failed");
		const calls = fetcher.mock.calls.length;
		await flush(POLL * 3);
		expect(fetcher).toHaveBeenCalledTimes(calls);
		expect(fetcher).toHaveBeenCalledWith({ data: 7 });
	});

	it("treats a missing status as terminal ('none') and stops", async () => {
		const fetcher = vi.fn(async () => ({ audioKey: null }) as Detail);
		renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		await flush(POLL * 2);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("keeps polling on an unknown status", async () => {
		const fetcher = vi.fn(async () => ({ audioStatus: "weird" }) as Detail);
		renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		await flush(POLL * 2);
		expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
	});

	it("gives the LLM cleanup a few extra polls after 'done', then stops", async () => {
		const fetcher = vi.fn(
			async () =>
				({ audioStatus: "done", serverTranscript: "raw", correctedTranscript: null }) as Detail,
		);
		const { result } = renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		await flush(POLL * 6);
		// 1 initial + 3 settle polls (SETTLE_POLLS) + the one that gives up
		expect(fetcher).toHaveBeenCalledTimes(4);
		expect(result.current?.audioStatus).toBe("done");
	});

	it("stops immediately on 'done' when the corrected transcript already exists", async () => {
		const fetcher = vi.fn(
			async () =>
				({ audioStatus: "done", serverTranscript: "raw", correctedTranscript: "clean" }) as Detail,
		);
		renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		await flush(POLL * 3);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});

	it("ignores empty results and transient failures and keeps polling", async () => {
		const fetcher = vi
			.fn<(i: { data: number }) => Promise<Detail | null>>()
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValue({ audioStatus: "done", serverTranscript: null });
		const { result } = renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		expect(result.current).toBeNull();
		await flush();
		expect(result.current).toBeNull();
		await flush();
		expect(result.current?.audioStatus).toBe("done");
	});

	it("drops a response that lands after unmount", async () => {
		let resolve!: (d: Detail) => void;
		const fetcher = vi.fn(() => new Promise<Detail>((r) => (resolve = r)));
		const { result, unmount } = renderHook(() => useConsultationAudio(fetcher, 1));
		await flush(0);
		unmount();
		await act(async () => resolve({ audioStatus: "done" }));
		expect(result.current).toBeNull();
	});

	it("returns null for a consultation other than the one last fetched", async () => {
		const fetcher = vi.fn(async () => ({ audioStatus: "done" }) as Detail);
		const { result, rerender } = renderHook(({ id }) => useConsultationAudio(fetcher, id), {
			initialProps: { id: 1 },
		});
		await flush(0);
		expect(result.current).not.toBeNull();
		fetcher.mockImplementation(() => new Promise(() => {}));
		rerender({ id: 2 });
		expect(result.current).toBeNull();
	});
});

describe("AudioTranscriptPanel", () => {
	it("shows the empty state without any text or status", () => {
		render(<AudioTranscriptPanel consultationId={null} />);
		expect(screen.getByText("No transcript.")).toBeTruthy();
		expect(screen.queryByText(/enhanc/)).toBeNull();
	});

	it("labels the in-flight states", () => {
		const { rerender } = render(
			<AudioTranscriptPanel consultationId={1} audioStatus="stored" browserText="oi" />,
		);
		expect(screen.getByText("audio stored")).toBeTruthy();
		rerender(<AudioTranscriptPanel consultationId={1} audioStatus="processing" browserText="oi" />);
		expect(screen.getByText("enhancing transcript…")).toBeTruthy();
	});

	it("flags a failed enhancement and offers playback when audio exists", () => {
		render(
			<AudioTranscriptPanel consultationId={9} audioStatus="failed" hasAudio browserText="oi" />,
		);
		expect(screen.getByText(/enhancement failed/)).toBeTruthy();
		expect(screen.getByLabelText("Consultation audio").getAttribute("src")).toBe(
			"/api/consultations/9/audio",
		);
	});

	it("does not render the player without a consultation id", () => {
		render(
			<AudioTranscriptPanel consultationId={null} audioStatus="failed" hasAudio browserText="x" />,
		);
		expect(screen.queryByLabelText("Consultation audio")).toBeNull();
	});

	it("shows only the corrected text when there is no original to compare", () => {
		render(
			<AudioTranscriptPanel consultationId={1} audioStatus="done" correctedText="Texto limpo." />,
		);
		expect(screen.getByText("Texto limpo.")).toBeTruthy();
		expect(screen.getByText("enhanced ✓")).toBeTruthy();
		expect(screen.queryByRole("tab")).toBeNull();
	});

	it("collapses to one pane when the corrected text equals the original", () => {
		render(
			<AudioTranscriptPanel
				consultationId={1}
				audioStatus="done"
				serverText="Mesmo texto"
				correctedText=" Mesmo texto "
			/>,
		);
		expect(screen.queryByRole("tab")).toBeNull();
		expect(screen.getByText("server · whisper large-v3-turbo")).toBeTruthy();
	});

	it("offers Corrected/Original tabs and reports the viewed text", () => {
		const onActiveText = vi.fn();
		render(
			<AudioTranscriptPanel
				consultationId={1}
				audioStatus="done"
				browserText="local"
				serverText="servidor"
				correctedText="corrigido"
				onActiveText={onActiveText}
			/>,
		);
		expect(onActiveText).toHaveBeenLastCalledWith({ text: "corrigido", source: "llm corrected" });
		fireEvent.mouseDown(screen.getByRole("tab", { name: "Original" }), { button: 0 });
		fireEvent.click(screen.getByRole("tab", { name: "Original" }));
		expect(onActiveText).toHaveBeenLastCalledWith({
			text: "servidor",
			source: "server · whisper large-v3-turbo",
		});
		// both raw outputs are listed, server first, browser as a second block
		expect(screen.getByText("servidor")).toBeTruthy();
		expect(screen.getByText("local")).toBeTruthy();
		expect(screen.getByText("browser")).toBeTruthy();
	});

	it("does not re-report identical text when only the callback identity changes", () => {
		const first = vi.fn();
		const second = vi.fn();
		const { rerender } = render(
			<AudioTranscriptPanel consultationId={1} browserText="igual" onActiveText={first} />,
		);
		expect(first).toHaveBeenCalledTimes(1);
		rerender(<AudioTranscriptPanel consultationId={1} browserText="igual" onActiveText={second} />);
		expect(second).not.toHaveBeenCalled();
		rerender(<AudioTranscriptPanel consultationId={1} browserText="outro" onActiveText={second} />);
		expect(second).toHaveBeenCalledWith({ text: "outro", source: "browser" });
	});

	it("renders speaker-labelled lines as bubbles", () => {
		render(<AudioTranscriptPanel consultationId={1} browserText={"Doctor: bom dia\nsem rótulo"} />);
		expect(screen.getByText("Doctor")).toBeTruthy();
		expect(screen.getByText("bom dia")).toBeTruthy();
		expect(screen.getByText("sem rótulo")).toBeTruthy();
	});
});

describe("AudioTranscriptPanel — karaoke segments", () => {
	beforeAll(() => {
		// jsdom lacks scrollIntoView; SegmentsKaraoke scrolls the active row.
		window.Element.prototype.scrollIntoView = vi.fn();
	});

	const KARAOKE = [
		{ start: 0, end: 2, text: "Primeira frase.", avgLogprob: -0.1 },
		{ start: 2, end: 4, text: "Segunda frase.", avgLogprob: -0.9 },
	];

	it("segment rows seek on click and follow the playhead", async () => {
		const playSpy = vi.fn(() => Promise.resolve());
		window.HTMLMediaElement.prototype.play = playSpy;
		render(
			<AudioTranscriptPanel
				consultationId={1}
				hasAudio
				audioStatus="done"
				browserText="x"
				segments={KARAOKE}
			/>,
		);
		const audio = document.querySelector("audio")!;
		fireEvent.click(screen.getByText("Segunda frase."));
		expect(audio.currentTime).toBe(2);
		expect(playSpy).toHaveBeenCalled();
		// Playhead inside a segment highlights its row (active ref + class).
		audio.currentTime = 1;
		fireEvent.timeUpdate(audio);
		fireEvent.timeUpdate(audio);
		// Outside every segment → no active row.
		audio.currentTime = 99;
		fireEvent.timeUpdate(audio);
	});

	it("segment rows degrade to plain buttons without a playable source", () => {
		render(
			<AudioTranscriptPanel
				consultationId={null}
				hasAudio
				audioStatus="done"
				browserText="x"
				segments={KARAOKE}
			/>,
		);
		expect(document.querySelector("audio")).toBeNull();
		// seek() guard: no audio element → click is a no-op.
		fireEvent.click(screen.getByText("Segunda frase."));
	});

	it("swallows a rejected play() on karaoke seek", async () => {
		window.HTMLMediaElement.prototype.play = vi.fn(() => Promise.reject(new Error("nope")));
		render(
			<AudioTranscriptPanel
				consultationId={1}
				hasAudio
				audioStatus="done"
				browserText="x"
				segments={KARAOKE}
			/>,
		);
		fireEvent.click(screen.getByText("Segunda frase."));
		await act(async () => {});
	});
});

describe("ConsultationAudioPlayer", () => {
	const GAPS: TranscriptSegment[] = [
		{ start: 0, end: 2, text: "bom dia" },
		{ start: 5, end: 8, text: "como está" }, // 3s silence at 2–5
		{ start: 8.4, end: 10, text: "vou examinar" },
	];

	const renderPlayer = (segments?: TranscriptSegment[]) => {
		const ref = { current: null as HTMLAudioElement | null };
		render(
			<ConsultationAudioPlayer
				src="/audio.wav"
				audioRef={ref}
				segments={segments}
				rateLabel="Playback speed"
				skipSilenceLabel="Skip silence"
			/>,
		);
		return { ref, audio: document.querySelector("audio")! };
	};

	const playing = (audio: HTMLAudioElement, paused: boolean) =>
		Object.defineProperty(audio, "paused", { value: paused, configurable: true });

	it("cycles playback rate and applies it to the audio element", () => {
		const { audio } = renderPlayer();
		const btn = screen.getByRole("button", { name: "Playback speed" });
		expect(btn.textContent).toBe("1×");
		fireEvent.click(btn);
		expect(audio.playbackRate).toBe(1.25);
		expect(btn.textContent).toBe("1.25×");
		fireEvent.click(btn);
		expect(audio.playbackRate).toBe(1.5);
		fireEvent.click(btn);
		expect(audio.playbackRate).toBe(2);
		fireEvent.click(btn);
		expect(audio.playbackRate).toBe(1);
	});

	it("persists the rate preference across mounts", () => {
		const { audio } = renderPlayer();
		fireEvent.click(screen.getByRole("button", { name: "Playback speed" }));
		expect(localStorage.getItem("ktb.audio.playbackRate")).toBe("1.25");
		cleanup();
		const second = renderPlayer();
		expect(second.audio.playbackRate).toBe(1.25);
	});

	it("skips silence gaps while playing", () => {
		const { audio } = renderPlayer(GAPS);
		playing(audio, false);
		audio.currentTime = 3; // inside the 2–5 gap
		fireEvent.timeUpdate(audio);
		expect(audio.currentTime).toBe(5);
	});

	it("does not skip while paused (manual seek into a gap)", () => {
		const { audio } = renderPlayer(GAPS);
		playing(audio, true);
		audio.currentTime = 3;
		fireEvent.timeUpdate(audio);
		expect(audio.currentTime).toBe(3);
	});

	it("does not skip inside a segment", () => {
		const { audio } = renderPlayer(GAPS);
		playing(audio, false);
		audio.currentTime = 6;
		fireEvent.timeUpdate(audio);
		expect(audio.currentTime).toBe(6);
	});

	it("skip toggle disables the jump and persists off", () => {
		const { audio } = renderPlayer(GAPS);
		fireEvent.click(screen.getByRole("button", { name: "Skip silence" }));
		expect(localStorage.getItem("ktb.audio.skipSilence")).toBe("0");
		playing(audio, false);
		audio.currentTime = 3;
		fireEvent.timeUpdate(audio);
		expect(audio.currentTime).toBe(3);
	});

	it("hides the skip control when there are no gaps", () => {
		renderPlayer([
			{ start: 0, end: 2, text: "a" },
			{ start: 2.5, end: 4, text: "b" },
		]);
		expect(screen.queryByRole("button", { name: "Skip silence" })).toBeNull();
	});
});
