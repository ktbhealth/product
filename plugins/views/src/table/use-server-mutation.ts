import { useCallback, useState } from "react";

import { useRouter } from "@tanstack/react-router";

/**
 * Mutation runner for admin-table pages — the shared replacement for
 * the `busy`/`error`/`router.invalidate()` boilerplate in the
 * `Admin*Page` views.
 *
 * `fn` is a server-fn-shaped call: it receives `{ data: input }` and
 * resolves a result envelope. `{ ok: true }` invalidates the router
 * (re-running loaders) and resolves `true`; `{ ok: false }`, a
 * non-envelope value, or a thrown error sets `error` and resolves
 * `false`. `error` resets on every call.
 */

export interface ServerMutationOk<O> {
	readonly ok: true;
	readonly data: O;
}

export interface ServerMutationFail {
	readonly ok: false;
}

export type ServerMutationResult<O> = ServerMutationOk<O> | ServerMutationFail;

export interface ServerMutation<I> {
	readonly busy: boolean;
	readonly error: boolean;
	readonly mutate: (input: I) => Promise<boolean>;
}

export function useServerMutation<I, O = unknown>(
	fn: (args: { data: I }) => Promise<ServerMutationResult<O>>,
): ServerMutation<I> {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);

	const mutate = useCallback(
		async (input: I): Promise<boolean> => {
			setBusy(true);
			setError(false);
			try {
				const res = await fn({ data: input });
				if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === true) {
					await router.invalidate();
					return true;
				}
				setError(true);
				return false;
			} catch {
				setError(true);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[fn, router],
	);

	return { busy, error, mutate };
}
