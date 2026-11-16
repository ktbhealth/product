import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

vi.mock("@tanstack/react-start/server", () => ({
	// Fresh Headers per call: @ktb/server-fns memoizes session lookups
	// per request keyed on the Headers identity.
	getRequestHeaders: () => new Headers(headers.current),
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

import { ApiKeys, Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Permissions } from "@ktb/rbac";
import { resetServerRuntime, setServerRuntime, type ServerRuntime } from "@ktb/server-fns";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { CredentialsLive } from "./index.ts";
import { createCredentialFn, listCredentialsFn, removeCredentialFn } from "./fns.ts";

const sessionFor = (email: string | null) =>
	email === null
		? null
		: {
				user: { id: `id-${email}`, email, name: email },
				sessionId: "s1",
				expiresAt: new Date(Date.now() + 3600_000),
			};

describe("credentials fns", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let currentEmail: string | null = null;
	let allow = true;

	beforeAll(() => {
		// In-memory ApiKeys port — same contract as the adapter: rows
		// per referenceId, metadata JSON carries {provider, secret} at
		// rest; `create` adds the `secretLast4` hint and `list` strips
		// `secret` before it leaves the port.
		const store = new Map<
			string,
			{ name: string; metadata: Record<string, unknown>; referenceId: string }
		>();
		let n = 0;
		const apiKeys = ApiKeys.of({
			create: async (input) => {
				n += 1;
				const id = `k${n}`;
				const secret = input.metadata.secret;
				const metadata =
					typeof secret === "string" && secret.length > 4
						? { ...input.metadata, secretLast4: secret.slice(-4) }
						: input.metadata;
				store.set(id, {
					name: input.name,
					metadata,
					referenceId: input.referenceId,
				});
				return { id };
			},
			list: async (referenceId) =>
				[...store.entries()]
					.filter(([, v]) => v.referenceId === referenceId)
					.map(([id, v]) => {
						const { secret: _secret, ...rest } = v.metadata;
						return {
							id,
							referenceId: v.referenceId,
							name: v.name,
							start: "sk",
							enabled: true,
							metadata: JSON.stringify(rest),
						};
					}),
			remove: async (keyId, referenceId) => {
				if (store.get(keyId)?.referenceId === referenceId) store.delete(keyId);
			},
			getSecret: async () => null,
		});
		const env = Layer.mergeAll(
			Layer.succeed(ApiKeys, apiKeys),
			Layer.succeed(
				Permissions,
				Permissions.of({
					permissionsFor: () => Effect.succeed(new Map()),
					canFor: () => Effect.succeed(allow),
					can: () => Effect.succeed(allow),
					requirePermissionFor: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					requirePermission: () =>
						allow ? Effect.void : Effect.fail({ _tag: "Forbidden", path: "rbac.eval.validator" }),
					invalidate: () => Effect.void,
				} as never),
			),
		);
		runtime = ManagedRuntime.make(
			Layer.merge(CredentialsLive.pipe(Layer.provide(env)), env) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const auth = Auth.of({
			setUserBanned: async () => {},
			getSession: async () => sessionFor(currentEmail) as never,
		});
		setServerRuntime({
			run: ((effect: Effect.Effect<unknown, unknown, unknown>) =>
				runtime.runPromise(effect.pipe(Effect.provideService(Auth, auth)))) as ServerRuntime["run"],
			runAs: ((
				user: { id: string; email: string },
				effect: Effect.Effect<unknown, unknown, unknown>,
			) =>
				runtime.runPromise(
					effect.pipe(
						Effect.provideService(Principal, {
							userId: user.id,
							email: user.email,
						}),
					),
				)) as ServerRuntime["runAs"],
			audioTranscribeModel: "test-model",
			getLocale: () => "en",
		});
	});

	afterAll(() => {
		resetServerRuntime();
		return runtime.dispose();
	});

	it("rejects anonymous callers", async () => {
		currentEmail = null;
		await expect(listCredentialsFn({ data: undefined })).rejects.toThrow("unauthenticated");
	});

	it("returns { ok: false } when the grant is missing", async () => {
		currentEmail = "v@x.com";
		allow = false;
		expect(await listCredentialsFn({ data: undefined })).toEqual({ ok: false });
		expect(
			await createCredentialFn({ data: { name: "k", provider: "openai", secret: "s" } }),
		).toEqual({ ok: false });
		expect(await removeCredentialFn({ data: { id: "k1" } })).toEqual({ ok: false });
		allow = true;
	});

	it("drives create → list → remove through the fn surface", async () => {
		const created = await createCredentialFn({
			data: { name: "prod key", provider: "openai", secret: "sk-live-1234" },
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;

		const listed = await listCredentialsFn({ data: undefined });
		expect(listed.ok && listed.data[0]?.name).toBe("prod key");
		expect(listed.ok && listed.data[0]?.masked).toBe("••••1234");

		expect(await removeCredentialFn({ data: { id: created.data.id } })).toEqual({
			ok: true,
			data: null,
		});
		const empty = await listCredentialsFn({ data: undefined });
		expect(empty.ok && empty.data).toHaveLength(0);
	});
});
