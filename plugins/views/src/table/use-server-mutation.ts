import { useCallback, useState } from "react";

import { useRouter } from "@tanstack/react-router";

/**
 * Mutation runner for admin-table pages — the shared replacement for
 * the `busy`/`error`/`router.invalidate()` boilerplate in the
 * `Admin*Page` views.
 *
 * `fn` is a server-fn-shaped call: it receives `{ data: input }` and
 * resolves a result. `true` or any `{ ok: true, ... }` envelope
 * invalidates the router (re-running loaders) and resolves `true`;
 * anything else — `{ ok: false }`, `false`, a non-envelope value —
 * or a thrown error sets `error`, stores the failing value on
 * `failure` and resolves `false`. `error` and `failure` reset on
 * every call.
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
	/** The failure payload of the last call: the resolved value on
	 * `{ ok: false }`/non-envelope results (e.g. `{ ok: false,
	 * error: "…" }` envelopes callers surface verbatim) or the thrown
	 * error. `undefined` after a successful call. */
	readonly failure: unknown;
	readonly mutate: (input: I) => Promise<boolean>;
}

export function useServerMutation<I>(
	fn: (args: { data: I }) => Promise<unknown>,
): ServerMutation<I> {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState(false);
	const [failure, setFailure] = useState<unknown>(undefined);

	const mutate = useCallback(
		async (input: I): Promise<boolean> => {
			setBusy(true);
			setError(false);
			setFailure(undefined);
			try {
				const res = await fn({ data: input });
				if (
					res === true ||
					(res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === true)
				) {
					await router.invalidate();
					return true;
				}
				setError(true);
				setFailure(res);
				return false;
			} catch (e) {
				setError(true);
				setFailure(e);
				return false;
			} finally {
				setBusy(false);
			}
		},
		[fn, router],
	);

	return { busy, error, failure, mutate };
}
