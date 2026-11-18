import { describe, expect, it, vi } from "vitest";

import { reactStartMock } from "@ktb/server-fns/testing";

import * as Effect from "effect/Effect";

const server = vi.hoisted(() => ({
	user: null as { id: string; email?: string } | null,
	views: {
		query: vi.fn<(path: string, input?: unknown) => Effect.Effect<unknown, unknown>>(),
	},
	runAs:
		vi.fn<(user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) => Promise<unknown>>(),
	run: vi.fn<(eff: Effect.Effect<unknown, unknown, unknown>) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", () => reactStartMock());

vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		getSessionUser: async () => server.user,
		run: (eff: Effect.Effect<unknown, unknown, unknown>) => server.run(eff),
		runAs: (user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) =>
			server.runAs(user, eff),
	};
});

import { viewQueryFn } from "./fns.ts";
import { Views } from "./service.ts";

// The handler resolves `Views` inside the Effect; run/runAs are
// mocked to execute the effect with the stub service provided.
const provideViews = <A>(eff: Effect.Effect<A, unknown, unknown>): Promise<A> =>
	Effect.runPromise(
		(eff as Effect.Effect<A, unknown, typeof Views>).pipe(
			Effect.provideService(Views, server.views as never),
		),
	);

server.run.mockImplementation((eff: Effect.Effect<unknown, unknown, unknown>) => provideViews(eff));
server.runAs.mockImplementation((_user: unknown, eff: Effect.Effect<unknown, unknown, unknown>) =>
	provideViews(eff),
);

describe("viewQueryFn", () => {
	it("runs anonymous queries through run()", async () => {
		server.user = null;
		server.views.query.mockReturnValue(Effect.succeed({ mode: "list" }));
		const result = await viewQueryFn({
			data: { path: "/v/notes", offset: 10, values: { q: "an" } },
		});
		expect(result).toEqual({ mode: "list" });
		expect(server.run).toHaveBeenCalled();
		expect(server.runAs).not.toHaveBeenCalled();
		expect(server.views.query).toHaveBeenCalledWith("/v/notes", {
			offset: 10,
			values: { q: "an" },
		});
	});

	it("runs session queries through runAs()", async () => {
		server.user = { id: "u1", email: "u@x" };
		server.views.query.mockReturnValue(Effect.succeed(null));
		const result = await viewQueryFn({ data: { path: "/v/notes" } });
		expect(result).toBeNull();
		expect(server.runAs).toHaveBeenCalled();
		expect(server.views.query).toHaveBeenCalledWith("/v/notes", {});
	});

	it("collapses handled store errors to null", async () => {
		server.user = null;
		server.views.query.mockReturnValue(Effect.fail({ _tag: "UnknownCollection", name: "x" }));
		await expect(viewQueryFn({ data: { path: "/v/notes" } })).resolves.toBeNull();
		server.views.query.mockReturnValue(
			Effect.fail({ _tag: "InvalidDocumentQuery", collection: "x", issues: [] }),
		);
		await expect(viewQueryFn({ data: { path: "/v/notes" } })).resolves.toBeNull();
	});

	it("rethrows unexpected errors", async () => {
		server.user = null;
		server.views.query.mockReturnValue(Effect.fail(new Error("boom")));
		await expect(viewQueryFn({ data: { path: "/v/notes" } })).rejects.toThrow("boom");
	});
});
