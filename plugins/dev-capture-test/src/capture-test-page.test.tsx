// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PageContext } from "@ktb/kernel";
import { act, type ReactElement } from "react";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { devCaptureTestPagesPlugin } from "./index.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const Page = devCaptureTestPagesPlugin.pages?.[0]?.component as () => ReactElement;

const ctx: PageContext = { plugins: [], locale: "en" };

const renderPage = () =>
	render(createElement(Page, { data: null, ctx } as { data: unknown; ctx: PageContext }));

function makeStream(withAudio = true) {
	const audioTrack = { label: "tab-audio", readyState: "live", stop: vi.fn<() => void>() };
	const videoTrack = { label: "tab-video", readyState: "live", stop: vi.fn<() => void>() };
	return {
		getAudioTracks: () => (withAudio ? [audioTrack] : []),
		getVideoTracks: () => [videoTrack],
		getTracks: () => [audioTrack, videoTrack],
	};
}

function mockAudioContext() {
	const analyser = {
		fftSize: 256,
		frequencyBinCount: 128,
		getByteTimeDomainData: (d: Uint8Array) => d.fill(128),
		connect: vi.fn<() => void>(),
	};
	return {
		createMediaStreamSource: () => ({ connect: vi.fn<() => void>() }),
		createAnalyser: () => analyser,
		close: vi.fn<() => Promise<void>>(async () => {}),
	};
}

function installMedia(stream: unknown) {
	const getDisplayMedia = vi.fn<() => Promise<unknown>>(async () => stream);
	vi.stubGlobal(
		"navigator",
		Object.assign(Object.create(navigator), {
			mediaDevices: { getDisplayMedia },
		}),
	);
	vi.stubGlobal(
		"AudioContext",
		vi.fn<() => unknown>(function (this: unknown) {
			return mockAudioContext();
		}),
	);
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn<() => number>(() => 1),
	);
	vi.stubGlobal("cancelAnimationFrame", vi.fn<(id: number) => void>());
	return getDisplayMedia;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("CaptureTestPage", () => {
	it("renders localized copy for the active locale", () => {
		renderPage();
		expect(screen.getByRole("heading", { name: "Spike: tab audio capture" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Start capture" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
	});

	it("renders pt-BR copy when ctx.locale is pt-BR", () => {
		render(
			createElement(Page, {
				data: null,
				ctx: { plugins: [], locale: "pt-BR" },
			} as { data: unknown; ctx: PageContext }),
		);
		expect(screen.getByRole("heading", { name: "Spike: captura de áudio da aba" })).toBeTruthy();
	});

	it("captures tab audio and shows level meter", async () => {
		installMedia(makeStream());
		renderPage();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start/i }));
		});
		await waitFor(() => expect(screen.getByText(/capturing/)).toBeTruthy());
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});
	});

	it("stop before capture is a no-op", async () => {
		const getDisplayMedia = installMedia(makeStream());
		renderPage();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /stop/i }));
		});
		expect(getDisplayMedia).not.toHaveBeenCalled();
		expect(screen.queryByText(/capturing/)).toBeNull();
	});

	it("shows error when share has no audio track", async () => {
		installMedia(makeStream(false));
		renderPage();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start/i }));
		});
		await waitFor(() => expect(screen.getByText(/no audio/)).toBeTruthy());
	});

	it("shows error when getDisplayMedia fails", async () => {
		vi.stubGlobal(
			"navigator",
			Object.assign(Object.create(navigator), {
				mediaDevices: {
					getDisplayMedia: vi.fn<() => Promise<unknown>>(async () =>
						Promise.reject(new Error("denied")),
					),
				},
			}),
		);
		renderPage();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start/i }));
		});
		await waitFor(() => expect(screen.getByText("denied")).toBeTruthy());
	});

	it("shows string error for non-Error rejection", async () => {
		vi.stubGlobal(
			"navigator",
			Object.assign(Object.create(navigator), {
				mediaDevices: {
					getDisplayMedia: vi.fn<() => Promise<unknown>>(async () => Promise.reject("nope")),
				},
			}),
		);
		renderPage();
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: /start/i }));
		});
		await waitFor(() => expect(screen.getByText("nope")).toBeTruthy());
	});
});
