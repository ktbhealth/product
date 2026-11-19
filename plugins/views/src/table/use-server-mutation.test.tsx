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
		const { result } = renderHook(() => useServerMutation<Input, Output>(fn));
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
		const { result } = renderHook(() => useServerMutation<Input, Output>(fn));
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
		const { result } = renderHook(() => useServerMutation<Input, Output>(fn));

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
