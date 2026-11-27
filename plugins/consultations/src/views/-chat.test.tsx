// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	AnamnesisSection,
	AudioBars,
	EncryptionPill,
	ListeningIndicator,
	PatientContextBar,
	RecordingIndicator,
	SpeakerAvatar,
	SpeakerChatRow,
	TranscriptPanelHeader,
	speakerInitials,
} from "./-chat.tsx";

afterEach(cleanup);

describe("speakerInitials", () => {
	it("maps SPEAKER_NN to its 1-indexed number", () => {
		expect(speakerInitials("SPEAKER_00")).toBe("1");
		expect(speakerInitials("SPEAKER_12")).toBe("13");
	});

	it("takes initials of named speakers and falls back on blanks", () => {
		expect(speakerInitials("Dr. Emmanuel")).toBe("DE");
		expect(speakerInitials("Maria")).toBe("M");
		expect(speakerInitials("")).toBe("?");
	});
});

describe("SpeakerAvatar", () => {
	it("renders speaker initials tone-matched", () => {
		render(<SpeakerAvatar speaker="SPEAKER_00" />);
		expect(screen.getByText("1")).toBeTruthy();
	});

	it("renders the dash for unattributed speech", () => {
		render(<SpeakerAvatar />);
		expect(screen.getByText("—")).toBeTruthy();
	});
});

describe("SpeakerChatRow", () => {
	it("renders name, time, role chip and actions", () => {
		render(
			<SpeakerChatRow
				speaker="SPEAKER_00"
				name="Locutor 1"
				time="00:05"
				roleLabel="Médico"
				actions={<button type="button">edit</button>}
			>
				hello
			</SpeakerChatRow>,
		);
		expect(screen.getByText("Locutor 1")).toBeTruthy();
		expect(screen.getByText("00:05")).toBeTruthy();
		expect(screen.getByText("Médico")).toBeTruthy();
		expect(screen.getByRole("button", { name: "edit" })).toBeTruthy();
		expect(screen.getByText("hello")).toBeTruthy();
	});

	it("omits time, role and actions when not provided", () => {
		render(
			<SpeakerChatRow speaker="SPEAKER_01" name="Locutor 2">
				hi
			</SpeakerChatRow>,
		);
		expect(screen.getByText("Locutor 2")).toBeTruthy();
		expect(screen.queryByText("00:05")).toBeNull();
	});

	it("seeks on bubble click and Enter, ignores other keys", () => {
		const onSeek = vi.fn();
		const { container } = render(
			<SpeakerChatRow name="Locutor 1" onSeek={onSeek}>
				body
			</SpeakerChatRow>,
		);
		const bubble = container.querySelector("[data-slot=bubble-content]")!;
		fireEvent.click(bubble);
		expect(onSeek).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(bubble, { key: "Enter" });
		expect(onSeek).toHaveBeenCalledTimes(2);
		fireEvent.keyDown(bubble, { key: "x" });
		expect(onSeek).toHaveBeenCalledTimes(2);
	});

	it("is not interactive without onSeek", () => {
		const { container } = render(<SpeakerChatRow name="n">b</SpeakerChatRow>);
		const bubble = container.querySelector("[data-slot=bubble-content]")!;
		expect(bubble.getAttribute("role")).toBeNull();
		expect(bubble.getAttribute("tabindex")).toBeNull();
	});
});

describe("PatientContextBar", () => {
	it("renders name, meta fragments, chips and actions", () => {
		render(
			<PatientContextBar
				name="Luís Fernando Silva"
				meta={["42 anos", "Prontuário #4092"]}
				chips={<span data-testid="chip">Hipertensão</span>}
				actions={<button type="button">Anamnese IA</button>}
			/>,
		);
		expect(screen.getByText("Luís Fernando Silva")).toBeTruthy();
		expect(screen.getByText("42 anos")).toBeTruthy();
		expect(screen.getByText("Prontuário #4092")).toBeTruthy();
		expect(screen.getByTestId("chip")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Anamnese IA" })).toBeTruthy();
		expect(screen.getByText("LF")).toBeTruthy();
	});

	it("renders the placeholder initial for an empty name", () => {
		render(<PatientContextBar name=" " />);
		expect(screen.getByText("?")).toBeTruthy();
	});
});

describe("EncryptionPill / ListeningIndicator", () => {
	it("render their content", () => {
		render(<EncryptionPill>lgpd</EncryptionPill>);
		render(<ListeningIndicator>listening…</ListeningIndicator>);
		expect(screen.getByText("lgpd")).toBeTruthy();
		expect(screen.getByText("listening…")).toBeTruthy();
	});
});

describe("AudioBars", () => {
	it("renders four animated bars", () => {
		const { container } = render(<AudioBars />);
		expect(container.querySelectorAll("span[style]").length).toBe(4);
	});
});

describe("RecordingIndicator", () => {
	it("shows the elapsed time and stops via the button", () => {
		const onStop = vi.fn();
		render(<RecordingIndicator elapsed="14:28" onStop={onStop} stopLabel="Stop" />);
		expect(screen.getByText("14:28")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(onStop).toHaveBeenCalledTimes(1);
	});

	it("renders no button without onStop", () => {
		render(<RecordingIndicator elapsed="00:01" />);
		expect(screen.queryByRole("button")).toBeNull();
	});
});

describe("TranscriptPanelHeader", () => {
	it("shows the title and right-side controls", () => {
		render(
			<TranscriptPanelHeader live title="Transcrição">
				<button type="button">Copiar</button>
			</TranscriptPanelHeader>,
		);
		expect(screen.getByText("Transcrição")).toBeTruthy();
		expect(screen.getByRole("button", { name: "Copiar" })).toBeTruthy();
	});

	it("renders without children slot", () => {
		render(<TranscriptPanelHeader title="t" />);
		expect(screen.getByText("t")).toBeTruthy();
	});
});

describe("AnamnesisSection", () => {
	it("renders title, status and body", () => {
		render(
			<AnamnesisSection title="Queixa Principal" status={<span>Confirmado</span>}>
				<p>content</p>
			</AnamnesisSection>,
		);
		expect(screen.getByText("Queixa Principal")).toBeTruthy();
		expect(screen.getByText("Confirmado")).toBeTruthy();
		expect(screen.getByText("content")).toBeTruthy();
	});
});
