import { describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

const server = vi.hoisted(() => ({
	user: null as { id: string; email?: string } | null,
	flows: {
		currentState: vi.fn<(input: unknown) => Effect.Effect<unknown, unknown>>(),
		canTransition: vi.fn<(input: unknown) => Effect.Effect<unknown, unknown>>(),
		transition: vi.fn<(input: unknown) => Effect.Effect<unknown, unknown>>(),
	},
	runAs:
		vi.fn<(user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((x: unknown) => unknown) | undefined;
		const chain = {
			validator: (v: (x: unknown) => unknown) => {
				validate = v;
				return chain;
			},
			handler: (h: (arg?: { data?: unknown }) => unknown) => async (arg?: { data?: unknown }) =>
				h(arg === undefined ? {} : { ...arg, data: validate ? validate(arg.data) : arg.data }),
		};
		return chain;
	},
}));

vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		ensureSessionUser: async () => {
			if (server.user === null) throw new Error("unauthenticated");
			return server.user;
		},
		runAs: (user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) =>
			server.runAs(user, eff),
	};
});

import { canTransitionFlowFn, flowStateFn, transitionFlowFn } from "./fns.ts";
import { Flows } from "./service.ts";

// The handler resolves `Flows` inside the Effect; runAs is mocked to
// execute the effect with the stub service provided.
const provideFlows = <A>(eff: Effect.Effect<A, unknown, unknown>): Promise<A> =>
	Effect.runPromise(
		(eff as Effect.Effect<A, unknown, typeof Flows>).pipe(
			Effect.provideService(Flows, server.flows as never),
		),
	);

server.runAs.mockImplementation((_user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) =>
	provideFlows(eff),
);

const stateInfo = {
	flow: { id: "doc-flow", collection: "test.docs" },
	state: "draft",
	record: { id: 7, data: { status: "draft" } },
};

const transitionResult = {
	flow: { id: "doc-flow", collection: "test.docs" },
	from: "draft",
	to: "review",
	record: { id: 7, data: { status: "review", note: "n" } },
};

describe("flowStateFn", () => {
	it("returns the wire state for a session user", async () => {
		server.user = { id: "u1", email: "u@x" };
		server.flows.currentState.mockReturnValue(Effect.succeed(stateInfo));
		const result = await flowStateFn({
			data: { flow: "doc-flow", collection: "test.docs", id: 7 },
		});
		expect(result).toEqual({
			flow: "doc-flow",
			collection: "test.docs",
			id: 7,
			state: "draft",
		});
		expect(server.flows.currentState).toHaveBeenCalledWith({
			flow: "doc-flow",
			collection: "test.docs",
			id: 7,
		});
		expect(server.runAs).toHaveBeenCalled();
	});

	it("returns null when the service reports no state", async () => {
		server.user = { id: "u1" };
		server.flows.currentState.mockReturnValue(Effect.succeed(null));
		await expect(
			flowStateFn({ data: { flow: "doc-flow", collection: "test.docs", id: 7 } }),
		).resolves.toBeNull();
	});

	it("collapses handled failures to null and rethrows the rest", async () => {
		server.user = { id: "u1" };
		server.flows.currentState.mockReturnValue(
			Effect.fail({ _tag: "UnknownCollection", name: "x" }),
		);
		await expect(
			flowStateFn({ data: { flow: "doc-flow", collection: "test.docs", id: 7 } }),
		).resolves.toBeNull();
		server.flows.currentState.mockReturnValue(Effect.fail(new Error("boom")));
		await expect(
			flowStateFn({ data: { flow: "doc-flow", collection: "test.docs", id: 7 } }),
		).rejects.toThrow("boom");
	});
});

describe("canTransitionFlowFn", () => {
	it("returns the service verdict", async () => {
		server.user = { id: "u1" };
		server.flows.canTransition.mockReturnValue(Effect.succeed(true));
		const result = await canTransitionFlowFn({
			data: {
				flow: "doc-flow",
				collection: "test.docs",
				id: 7,
				event: "submit",
				payload: { by: "u1" },
			},
		});
		expect(result).toBe(true);
		expect(server.flows.canTransition).toHaveBeenCalledWith({
			flow: "doc-flow",
			collection: "test.docs",
			id: 7,
			event: "submit",
			payload: { by: "u1" },
		});
	});

	it("collapses handled failures to false and rethrows the rest", async () => {
		server.user = { id: "u1" };
		server.flows.canTransition.mockReturnValue(
			Effect.fail({ _tag: "IllegalTransition", flow: "doc-flow" }),
		);
		await expect(
			canTransitionFlowFn({
				data: { flow: "doc-flow", collection: "test.docs", id: 7, event: "submit" },
			}),
		).resolves.toBe(false);
		server.flows.canTransition.mockReturnValue(Effect.fail(new Error("boom")));
		await expect(
			canTransitionFlowFn({
				data: { flow: "doc-flow", collection: "test.docs", id: 7, event: "submit" },
			}),
		).rejects.toThrow("boom");
	});
});

describe("transitionFlowFn", () => {
	it("returns the committed transition wire", async () => {
		server.user = { id: "u1" };
		server.flows.transition.mockReturnValue(Effect.succeed(transitionResult));
		const result = await transitionFlowFn({
			data: { flow: "doc-flow", collection: "test.docs", id: 7, event: "submit" },
		});
		expect(result).toEqual({
			flow: "doc-flow",
			collection: "test.docs",
			id: 7,
			event: "submit",
			from: "draft",
			to: "review",
			data: { status: "review", note: "n" },
		});
	});

	it("collapses every handled domain failure to null", async () => {
		server.user = { id: "u1" };
		for (const tag of [
			"UnknownFlow",
			"FlowRecordNotFound",
			"IllegalTransition",
			"FlowStateConflict",
			"FlowPermissionDenied",
			"RecordNotFound",
			"DocumentValidationError",
		]) {
			server.flows.transition.mockReturnValue(Effect.fail({ _tag: tag }));
			await expect(
				transitionFlowFn({
					data: { flow: "doc-flow", collection: "test.docs", id: 7, event: "submit" },
				}),
			).resolves.toBeNull();
		}
	});

	it("requires a session", async () => {
		server.user = null;
		await expect(
			transitionFlowFn({
				data: { flow: "doc-flow", collection: "test.docs", id: 7, event: "submit" },
			}),
		).rejects.toThrow("unauthenticated");
	});
});
