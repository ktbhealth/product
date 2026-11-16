import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vitest";

import { PortError } from "@ktb/eval-core";

// workerd has no node:child_process — the lazy import throws and the
// transport must surface that as the documented typed failure.
vi.mock("node:child_process", () => {
	throw new Error("workerd: module not found: node:child_process");
});

import { makeStdioRpc } from "./stdio-rpc.ts";

describe("makeStdioRpc without a Node runtime", () => {
	it("fails typed when node:child_process cannot be imported", async () => {
		const err = await Effect.runPromise(
			Effect.flip(Effect.scoped(makeStdioRpc({ argv: ["agent", "--acp"] }))),
		);
		expect(err).toBeInstanceOf(PortError);
		expect(err.message).toContain("requires a Node/Bun runtime");
	});
});
