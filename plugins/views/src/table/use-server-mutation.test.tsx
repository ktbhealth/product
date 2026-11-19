// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn<() => Promise<void>>(async () => {}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));

import { useServerMutation, type ServerMutationResult } from "./use-server-mutation.ts";

interface Input {
	userId: string;
}
interface Output {
	id: string;
}

beforeEach(() => {
	invalidate.mockClear();
});

describe("useServerMutation", () => {
	it("returns true and invalidates the router on ok:true", async () => {
		const fn = vi.fn<(args: { data: Input }) => Promise<ServerMutationResult<Output>>>(
			async () => ({ ok: true, data: { id: "u1" } }),
		);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.mutate({ userId: "u1" });
		});
		expect(ok).toBe(true);
		expect(fn).toHaveBeenCalledWith({ data: { userId: "u1" } });
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(result.current.error).toBe(false);
		expect(result.current.busy).toBe(false);
	});

	it("returns false, sets error and skips invalidate on ok:false", async () => {
		const fn = vi.fn<(args: { data: Input }) => Promise<ServerMutationResult<Output>>>(
			async () => ({ ok: false }),
		);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.mutate({ userId: "u1" });
		});
		expect(ok).toBe(false);
		expect(result.current.error).toBe(true);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("treats non-envelope resolutions as failures", async () => {
		const fn = vi.fn<(args: { data: Input }) => Promise<ServerMutationResult<Output>>>(
			async () => null as unknown as ServerMutationResult<Output>,
		);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.mutate({ userId: "u1" });
		});
		expect(ok).toBe(false);
		expect(result.current.error).toBe(true);
	});

	it("returns false and sets error on thrown errors", async () => {
		const fn = vi.fn<(args: { data: Input }) => Promise<ServerMutationResult<Output>>>(async () => {
			throw new Error("boom");
		});
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.mutate({ userId: "u1" });
		});
		expect(ok).toBe(false);
		expect(result.current.error).toBe(true);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("resets error on each call and toggles busy in flight", async () => {
		let resolveFn: (v: ServerMutationResult<Output>) => void = () => {};
		const fn = vi
			.fn<(args: { data: Input }) => Promise<ServerMutationResult<Output>>>()
			.mockImplementationOnce(
				() =>
					new Promise<ServerMutationResult<Output>>((res) => {
						resolveFn = res;
					}),
			)
			.mockResolvedValueOnce({ ok: false })
			.mockResolvedValueOnce({ ok: true, data: { id: "u3" } });
		const { result } = renderHook(() => useServerMutation<Input>(fn));

		let pending: Promise<boolean> | undefined;
		await act(async () => {
			pending = result.current.mutate({ userId: "u1" });
		});
		expect(result.current.busy).toBe(true);
		await act(async () => {
			resolveFn({ ok: true, data: { id: "u1" } });
			await pending;
		});
		expect(result.current.busy).toBe(false);
		expect(result.current.error).toBe(false);

		// next call fails → error set; following call succeeds → error cleared
		await act(async () => {
			expect(await result.current.mutate({ userId: "u2" })).toBe(false);
		});
		expect(result.current.error).toBe(true);
		// a subsequent success clears the error flag
		await act(async () => {
			expect(await result.current.mutate({ userId: "u3" })).toBe(true);
		});
		expect(result.current.error).toBe(false);
		expect(result.current.busy).toBe(false);
	});
});

describe("useServerMutation loose results", () => {
	it("treats bare true and { ok: true, ...extra } as success", async () => {
		const fn = vi
			.fn<(args: { data: Input }) => Promise<unknown>>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce({ ok: true, orphanedAudio: ["a1"] });
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		await act(async () => {
			expect(await result.current.mutate({ userId: "u1" })).toBe(true);
		});
		await act(async () => {
			expect(await result.current.mutate({ userId: "u2" })).toBe(true);
		});
		expect(invalidate).toHaveBeenCalledTimes(2);
	});

	it("treats bare false and non-envelope values as failure", async () => {
		const fn = vi
			.fn<(args: { data: Input }) => Promise<unknown>>()
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(undefined);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		await act(async () => {
			expect(await result.current.mutate({ userId: "u1" })).toBe(false);
		});
		expect(result.current.failure).toBe(false);
		await act(async () => {
			expect(await result.current.mutate({ userId: "u2" })).toBe(false);
		});
		expect(result.current.error).toBe(true);
		expect(result.current.failure).toBeUndefined();
		expect(invalidate).not.toHaveBeenCalled();
	});
});

describe("useServerMutation failure payload", () => {
	it("exposes the resolved failing value on `failure`", async () => {
		const failing = { ok: false as const, error: "denied by policy" };
		const fn = vi.fn<(args: { data: Input }) => Promise<unknown>>(async () => failing);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let ok: boolean | undefined;
		await act(async () => {
			ok = await result.current.mutate({ userId: "u1" });
		});
		expect(ok).toBe(false);
		expect(result.current.error).toBe(true);
		expect(result.current.failure).toBe(failing);
	});

	it("exposes thrown errors on `failure` and clears it on the next call", async () => {
		const boom = new Error("boom");
		const fn = vi
			.fn<(args: { data: Input }) => Promise<unknown>>()
			.mockRejectedValueOnce(boom)
			.mockResolvedValueOnce({ ok: true, data: { id: "u2" } });
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		await act(async () => {
			expect(await result.current.mutate({ userId: "u1" })).toBe(false);
		});
		expect(result.current.error).toBe(true);
		expect(result.current.failure).toBe(boom);
		// a subsequent call clears failure before resolving
		await act(async () => {
			expect(await result.current.mutate({ userId: "u2" })).toBe(true);
		});
		expect(result.current.error).toBe(false);
		expect(result.current.failure).toBeUndefined();
		expect(invalidate).toHaveBeenCalledTimes(1);
	});

	it("clears `failure` at the start of each call", async () => {
		let rejectFn: (e: unknown) => void = () => {};
		let resolveFn: (v: unknown) => void = () => {};
		const fn = vi
			.fn<(args: { data: Input }) => Promise<unknown>>()
			.mockImplementationOnce(
				() =>
					new Promise<unknown>((_res, rej) => {
						rejectFn = rej;
					}),
			)
			.mockImplementationOnce(
				() =>
					new Promise<unknown>((res) => {
						resolveFn = res;
					}),
			);
		const { result } = renderHook(() => useServerMutation<Input>(fn));
		let pending: Promise<boolean> | undefined;
		await act(async () => {
			pending = result.current.mutate({ userId: "u1" });
		});
		await act(async () => {
			rejectFn(new Error("late"));
			await pending;
		});
		expect(result.current.failure).toBeInstanceOf(Error);
		// in-flight call resets failure before the new result lands
		let pending2: Promise<boolean> | undefined;
		await act(async () => {
			pending2 = result.current.mutate({ userId: "u2" });
		});
		expect(result.current.failure).toBeUndefined();
		await act(async () => {
			resolveFn({ ok: false });
			await pending2;
		});
		expect(result.current.failure).toEqual({ ok: false });
	});
});
