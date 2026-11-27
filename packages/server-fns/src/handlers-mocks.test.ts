import { beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";

// Rebuild the handler wrappers on top of a vi.mock of "@ktb/server-fns"
// itself — the same pattern plugin fns.test.ts files use — so the lazy
// `import("@ktb/server-fns")` inside serverFnHandlerMocks resolves to
// these stubs. Covers every branch of the mock wrappers (lines CI flagged
// as uncovered when no plugin test exercised mock pluginHandler).
const mocks = vi.hoisted(() => ({
	ensureSessionUser: vi.fn(),
	ensureDoctorUser: vi.fn(),
	getSessionUser: vi.fn(),
	getDoctorUser: vi.fn(),
	requirePluginEnabled: vi.fn(),
	runAs: vi.fn(),
}));

vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return {
		...actual,
		ensureSessionUser: mocks.ensureSessionUser,
		ensureDoctorUser: mocks.ensureDoctorUser,
		getSessionUser: mocks.getSessionUser,
		getDoctorUser: mocks.getDoctorUser,
		requirePluginEnabled: mocks.requirePluginEnabled,
		runAs: mocks.runAs,
		...actual.serverFnHandlerMocks(),
	};
});

import {
	doctorHandler,
	optionalDoctorHandler,
	optionalSessionHandler,
	pluginHandler,
	sessionHandler,
} from "@ktb/server-fns";

const user = { id: "u1", email: "a@x.com" };
const doctor = { id: "u1", email: "a@x.com", actorId: "d1" };

beforeEach(() => {
	vi.clearAllMocks();
	mocks.ensureSessionUser.mockResolvedValue(user);
	mocks.ensureDoctorUser.mockResolvedValue(doctor);
	mocks.getSessionUser.mockResolvedValue(user);
	mocks.getDoctorUser.mockResolvedValue(doctor);
	mocks.requirePluginEnabled.mockResolvedValue(undefined);
	mocks.runAs.mockImplementation(async (_user: unknown, effect: unknown) =>
		Effect.runPromise(effect as Effect.Effect<unknown, unknown, never>),
	);
});

describe("serverFnHandlerMocks sessionHandler", () => {
	it("injects user and a run bound through the mocked runAs", async () => {
		const fn = sessionHandler<{ data: number }, string>(async ({ data, user: u, run }) => {
			expect(data).toBe(1);
			expect(u).toEqual(user);
			return run(Effect.succeed("done"));
		});
		await expect(fn({ data: 1 })).resolves.toBe("done");
		expect(mocks.ensureSessionUser).toHaveBeenCalledOnce();
		expect(mocks.runAs).toHaveBeenCalledWith(user, expect.anything());
	});
});

describe("serverFnHandlerMocks doctorHandler", () => {
	it("injects the acting doctor through the mocked ensureDoctorUser", async () => {
		const fn = doctorHandler(async ({ user: u, run }) => {
			expect(u).toEqual(doctor);
			return run(Effect.succeed("fx"));
		});
		await expect(fn({ data: undefined })).resolves.toBe("fx");
		expect(mocks.ensureDoctorUser).toHaveBeenCalledOnce();
		expect(mocks.runAs).toHaveBeenCalledWith(doctor, expect.anything());
	});
});

describe("serverFnHandlerMocks optionalSessionHandler", () => {
	it("answers anonymous callers through onAnonymous", async () => {
		mocks.getSessionUser.mockResolvedValue(null);
		const fn = optionalSessionHandler<{ data: number }, string>(
			(args) => `anon:${args.data}`,
			async ({ user: u }) => u.id,
		);
		await expect(fn({ data: 3 })).resolves.toBe("anon:3");
		expect(mocks.getSessionUser).toHaveBeenCalledOnce();
	});

	it("injects the session context for signed-in callers", async () => {
		const fn = optionalSessionHandler<{ data: string }, string>(
			() => "anon",
			async ({ data, user: u, run }) => run(Effect.succeed(`${u.id}:${data}`)),
		);
		await expect(fn({ data: "x" })).resolves.toBe("u1:x");
		expect(mocks.runAs).toHaveBeenCalledWith(user, expect.anything());
	});
});

describe("serverFnHandlerMocks optionalDoctorHandler", () => {
	it("collapses anonymous and no-doctor callers to onAnonymous", async () => {
		mocks.getDoctorUser.mockResolvedValue(null);
		const fn = optionalDoctorHandler<{ data: undefined }, string>(
			() => "hidden",
			async ({ user: u }) => u.id,
		);
		await expect(fn({ data: undefined })).resolves.toBe("hidden");
	});

	it("injects the acting doctor for eligible callers", async () => {
		const fn = optionalDoctorHandler<{ data: undefined }, string>(
			() => "hidden",
			async ({ user: u, run }) => run(Effect.succeed(`${u.id}/${u.actorId}`)),
		);
		await expect(fn({ data: undefined })).resolves.toBe("u1/d1");
		expect(mocks.runAs).toHaveBeenCalledWith(doctor, expect.anything());
	});
});

describe("serverFnHandlerMocks pluginHandler", () => {
	it("runs the enablement gate then delegates", async () => {
		const fn = pluginHandler<{ data: number }, string>(
			"demo.routes",
			async ({ data }) => `ok:${data}`,
		);
		await expect(fn({ data: 5 })).resolves.toBe("ok:5");
		expect(mocks.requirePluginEnabled).toHaveBeenCalledWith("demo.routes");
	});

	it("propagates a gate rejection without calling the handler", async () => {
		mocks.requirePluginEnabled.mockRejectedValue(new Error("disabled"));
		const inner = vi.fn(async () => "unreachable");
		const fn = pluginHandler("demo.routes", inner);
		await expect(fn({ data: undefined })).rejects.toThrow("disabled");
		expect(inner).not.toHaveBeenCalled();
	});
});
