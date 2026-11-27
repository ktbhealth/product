import { describe, expect, it } from "vitest";

import { whisperBackend, whisperCandidate } from "./index.ts";

describe("whisperCandidate", () => {
	it("is unsupported without browser media APIs and creates whisperBackend", () => {
		expect(whisperCandidate.id).toBe("whisper");
		expect(whisperCandidate.supported()).toBe(false);
		expect(whisperCandidate.create()).toBe(whisperBackend);
	});
});

describe("whisperBackend", () => {
	it("mic builds a mic transcriber with or without a deviceId", () => {
		const withDevice = whisperBackend.mic({ deviceId: "mic-1" });
		const withoutDevice = whisperBackend.mic();
		expect(typeof withDevice.start).toBe("function");
		expect(typeof withoutDevice.start).toBe("function");
	});
});
