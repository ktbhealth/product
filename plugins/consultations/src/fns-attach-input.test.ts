import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Auth } from "@ktb/auth";

import { attachAnamnesisFn } from "./fns.ts";

// attachAnamnesisFn validates its wire payload before touching the session;
// with no session the handler answers { ok: false }, so a returned value
// proves the validator accepted the input.

const runtime = ManagedRuntime.make(
	Layer.succeed(
		Auth,
		Auth.of({
			getSession: async () => null,
			setUserBanned: async () => {},
			updateUser: async () => ({ ok: true as const }),
			deleteUser: async () => {},
		}),
	) as Layer.Layer<unknown>,
);

beforeAll(() => {
	installServerFnRuntime(
		runtime,
		stubAuth(() => null),
	);
});
afterAll(async () => {
	resetServerFnRuntime();
	await runtime.dispose();
});

const section = { content: "x", confidence: "alta", evidence: ["e"] };
const anamnesis = {
	queixa_principal: section,
	hda: section,
	antecedentes: section,
	alergias: section,
	medicamentos_em_uso: section,
	exame_fisico: section,
	hipoteses: section,
	conduta: section,
};
const attach = (data: unknown) => attachAnamnesisFn({ data } as never);
const base = { consultationId: 1, anamnesis, engine: "e" };

describe("attachAnamnesisFn input validation", () => {
	it("accepts an explicit null patientId (clear the link)", async () => {
		await expect(attach({ ...base, patientId: null })).resolves.toEqual({ ok: false });
	});

	it("accepts an absent patientId and a numeric one", async () => {
		await expect(attach(base)).resolves.toEqual({ ok: false });
		await expect(attach({ ...base, patientId: 7 })).resolves.toEqual({ ok: false });
	});

	it("rejects payloads that are not objects", async () => {
		await expect(attach("nope")).rejects.toThrow();
		await expect(attach(null)).rejects.toThrow();
	});
});
