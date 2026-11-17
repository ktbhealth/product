import { describe, expect, it, vi } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

// An empty code-catalog baseline: the seed must still write locales but
// skip the baseline sync entirely (namespaces stay empty).
vi.mock("@ktb/i18n", async (importOriginal) => {
	const mod = await importOriginal<typeof import("@ktb/i18n")>();
	return { ...mod, I18N_BASELINE: [] };
});

import { I18N_TEST_DDL, i18nLocales, i18nNamespaces } from "./index.ts";
import { I18nRuntimeLive } from "./runtime.ts";

describe("runtime seed with an empty baseline", () => {
	it("seeds locales and skips baseline sync when I18N_BASELINE is empty", async () => {
		const db = makeDb(makeD1(I18N_TEST_DDL));
		const runtime = ManagedRuntime.make(I18nRuntimeLive.pipe(Layer.provide(Layer.succeed(Db, db))));
		await runtime.runPromise(Effect.void);

		expect(await db.select().from(i18nLocales)).not.toHaveLength(0);
		expect(await db.select().from(i18nNamespaces)).toHaveLength(0);
	});
});
