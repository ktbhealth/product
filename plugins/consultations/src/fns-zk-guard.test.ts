import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const headers = { current: new Headers() };

const vaultMocks = vi.hoisted(() => ({
	vaultDevicesFn: vi.fn(async () => ["dev-1"]),
	vaultDekEnvelopesFn: vi.fn(async () => ({ "3": "w1.e" })),
	vaultGrantAccessFn: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@tanstack/react-start/server", () => ({
	// Fresh Headers per call: @ktb/server-fns memoizes session lookups
	// per request keyed on the Headers identity, so reusing one object
	// would make every fn call look like the same request.
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
vi.mock("@ktb/vault/fns", () => vaultMocks);

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";
import { Principal } from "@ktb/authz";
import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { resetServerRuntime, setServerRuntime } from "@ktb/server-fns";
import { Tenant } from "@ktb/tenant";

import { consultationsZkApi } from "./apis.ts";
import { extractAnamnesisFn, patientHistoryRowsFn } from "./fns.ts";
import { Consultations } from "./index.ts";

const DDL = `
CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, meta TEXT, zk INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0);
INSERT INTO groups (id, name, slug, kind, zk) VALUES (7, 'ZK Clinic', 'zk', 'clinic', 1);
`;

const USER = { id: "u-doc", email: "doc@x.com", name: "Doc" };
const session = {
	user: USER,
	sessionId: "s1",
	expiresAt: new Date(Date.now() + 3600_000),
};

const db = makeDb(makeD1(DDL));
const runtime = ManagedRuntime.make(Layer.succeed(Db, db) as Layer.Layer<unknown>);
let activeSession: typeof session | null = session;
const auth = Auth.of({
	getSession: async () => activeSession as never,
	setUserBanned: async () => {},
});

const historyRowsResult = {
	count: 1,
	rows: [{ id: 3, anamnesis: "v1.a.b", createdAt: new Date(0) }],
};

beforeAll(() => {
	setServerRuntime({
		run: (effect) =>
			runtime.runPromise(
				(effect as Effect.Effect<unknown, unknown, unknown>).pipe(
					Effect.provideService(Auth, auth),
				),
			) as Promise<never>,
		runAs: (_user, effect) =>
			runtime.runPromise(
				(effect as Effect.Effect<unknown, unknown, unknown>).pipe(
					Effect.provideService(Principal, {
						userId: USER.id,
						email: USER.email,
					} as never),
					Effect.provideService(Tenant, {
						id: 7,
						kind: "clinic",
						slug: "zk",
						role: "admin",
					} as never),
					Effect.provideService(Consultations, {
						historyRows: () => Effect.succeed(historyRowsResult),
					} as never),
				),
			) as Promise<never>,
		getLocale: () => "en",
		audioTranscribeModel: "test-model",
	});
});
afterAll(async () => {
	resetServerRuntime();
	await runtime.dispose();
});

describe("extractAnamnesisFn under ZK", () => {
	it("returns null — the server engine never sees ZK transcripts", async () => {
		await expect(extractAnamnesisFn({ data: { transcript: "t" } })).resolves.toBeNull();
	});
});

describe("patientHistoryRowsFn", () => {
	it("returns the raw history rows for the bound doctor", async () => {
		await expect(patientHistoryRowsFn({ data: { patientId: 4, excludeId: 9 } })).resolves.toEqual(
			historyRowsResult,
		);
	});

	it("is null when the request has no doctor session", async () => {
		activeSession = null;
		try {
			await expect(patientHistoryRowsFn({ data: { patientId: 4 } })).resolves.toBeNull();
		} finally {
			activeSession = session;
		}
	});
});

describe("consultationsZkApi", () => {
	it("delegates to the vault fns with the fn call shape", async () => {
		expect(await consultationsZkApi.devices()).toEqual(["dev-1"]);
		expect(vaultMocks.vaultDevicesFn).toHaveBeenCalledWith();
		expect(
			await consultationsZkApi.dekEnvelopes({
				entityType: "consultation",
				entityIds: [3],
				wrapPublicKey: "w",
			}),
		).toEqual({ "3": "w1.e" });
		expect(vaultMocks.vaultDekEnvelopesFn).toHaveBeenCalledWith({
			data: { entityType: "consultation", entityIds: [3], wrapPublicKey: "w" },
		});
		expect(
			await consultationsZkApi.grant({
				entityType: "consultation",
				entityId: 3,
				grants: [{ readerKind: "device", readerPubkey: "w", wrappedDek: "w1.x" }],
			}),
		).toEqual({ ok: true });
		expect(vaultMocks.vaultGrantAccessFn).toHaveBeenCalledWith({
			data: {
				entityType: "consultation",
				entityId: 3,
				grants: [{ readerKind: "device", readerPubkey: "w", wrappedDek: "w1.x" }],
			},
		});
	});
});
