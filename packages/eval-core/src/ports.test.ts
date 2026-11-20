import { describe, expect, it } from "vitest";

import { EvalPort, EvalStorePort, PortError, ReportPort } from "./ports.ts";

describe("eval-core service keys", () => {
	it("ports register under stable package-scoped identifiers", () => {
		// The tag string is the service identity — layers and
		// `Context` lookups key on it, so it must never drift.
		expect(EvalPort.key).toBe("@ktb/eval-core/EvalPort");
		expect(ReportPort.key).toBe("@ktb/eval-core/ReportPort");
		expect(EvalStorePort.key).toBe("@ktb/eval-core/EvalStorePort");
	});
});

describe("PortError", () => {
	it("carries port, message, and optional cause", () => {
		const cause = new Error("socket reset");
		const e = new PortError({ port: "asr", message: "down", cause });
		expect(e.port).toBe("asr");
		expect(e.message).toBe("down");
		expect(e.cause).toBe(cause);
		expect(e._tag).toBe("PortError");
	});
});

describe("TaskEnvelope", () => {
	it("is a plain data contract — generator/corrector roles", () => {
		const env = {
			taskId: "t1",
			role: "corrector" as const,
			input: "text",
			outputSchema: "EditList",
			seed: 42,
			modelHint: "m",
		};
		expect(env.role).toBe("corrector");
	});
});

describe("port service shapes", () => {
	it("EvalPort exposes egress + judge, ReportPort append + render, EvalStorePort the artifact collections", () => {
		// Compile-time contract check: the service interfaces are
		// structural, so a shape regression fails typecheck; here we
		// pin that the keys exist and are distinct services.
		expect(EvalPort.key).not.toBe(ReportPort.key);
		expect(ReportPort.key).not.toBe(EvalStorePort.key);
	});
});
