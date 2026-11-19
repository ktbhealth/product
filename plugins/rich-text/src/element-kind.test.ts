import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { ElementKinds, ElementKindsLive } from "@ktb/platform/element-kinds";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";

import { richText } from "./schema.ts";
import { RichTextDeleteHooks, RichTextDeleteHooksLive } from "./delete-hooks.ts";
import { RichTextElementKindLive, RICH_TEXT_ELEMENT_KIND } from "./element-kind.ts";
import { RichTextsLive, RICH_TEXT_TEST_DDL } from "./service.ts";

/**
 * Element-kind registration (P-102): `RichTextElementKindLive` registers
 * the "rich-text" descriptor into the shared `ElementKinds` registry at
 * layer build — when the registry is provided (the app-host `core`
 * contract) — and builds cleanly without it (serviceOption absent
 * path). The composed layer mirrors the plugin's `services` field:
 * provideMerge wires the sibling RichTexts/RichTextDeleteHooks
 * services the descriptor resolves through.
 */

const docValue = [{ type: "p", children: [{ text: "hello" }] }];

describe("RichTextElementKindLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: ReturnType<typeof makeDb>;
	let docId: number;

	beforeAll(async () => {
		db = makeDb(makeD1(RICH_TEXT_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// Mirror the app-host composition: `core` (ElementKinds + infra)
		// is merged at top level AND provided into the plugin layer —
		// the same layer object, so the registry instance is shared.
		const core = Layer.mergeAll(ElementKindsLive, deps);
		const services = Layer.merge(RichTextsLive, RichTextDeleteHooksLive);
		const composed = RichTextElementKindLive.pipe(Layer.provideMerge(services));
		const app = Layer.mergeAll(core, composed.pipe(Layer.provide(core)));
		runtime = ManagedRuntime.make(app as Layer.Layer<unknown, never, never>);
		const rows = await db
			.insert(richText)
			.values({
				title: "Kind doc",
				value: JSON.stringify(docValue),
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.returning({ id: richText.id });
		docId = rows[0]!.id;
	});

	afterAll(() => runtime.dispose());

	it("registers the rich-text descriptor into ElementKinds", async () => {
		const kind = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				return kinds.get(RICH_TEXT_ELEMENT_KIND);
			}),
		);
		expect(kind?.kind).toBe("rich-text");
		expect(kind?.label).toBe("Rich text");
		expect(kind?.resolve).toBeTypeOf("function");
		expect(kind?.hooks?.usage).toBeTypeOf("function");
		expect(kind?.hooks?.cleanup).toBeTypeOf("function");
	});

	it("resolve maps a doc id to the renderable Plate value", async () => {
		const content = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				return yield* kinds.get(RICH_TEXT_ELEMENT_KIND)!.resolve(docId);
			}),
		);
		expect(content).toEqual(docValue);
	});

	it("resolve returns null for missing rows and malformed refs", async () => {
		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				const resolve = kinds.get(RICH_TEXT_ELEMENT_KIND)!.resolve;
				return [
					yield* resolve(999_999),
					yield* resolve("not-a-number"),
					yield* resolve(0),
					yield* resolve(-3),
					yield* resolve(1.5),
					yield* resolve(null),
				];
			}),
		);
		expect(results).toEqual([null, null, null, null, null, null]);
	});

	it("hooks.usage/cleanup delegate to the RichTextDeleteHooks registry", async () => {
		const seen: string[] = [];
		const outcome = await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* RichTextDeleteHooks;
				yield* hooks.register({
					id: "pages",
					usage: () => Effect.succeed([{ id: 11, title: "About", path: "/about" }]),
					// Real hooks no-op on action ids they don't own — the
					// stub honors the same contract.
					cleanup: (_docId, actionId) =>
						actionId.startsWith("pages.")
							? Effect.sync(() => {
									seen.push(actionId);
								})
							: Effect.void,
				});
				const kinds = yield* ElementKinds;
				const kindHooks = kinds.get(RICH_TEXT_ELEMENT_KIND)!.hooks!;
				const usage = yield* kindHooks.usage!(docId);
				// Foreign action ids are a silent no-op; owned ones run.
				yield* kindHooks.cleanup!(docId, "unrelated.action");
				yield* kindHooks.cleanup!(docId, "pages.delete-pages");
				// Malformed refs resolve to empty/no-op, never throw.
				const badUsage = yield* kindHooks.usage!("nope");
				yield* kindHooks.cleanup!(null, "pages.delete-pages");
				return { usage, badUsage };
			}),
		);
		expect(outcome.usage).toEqual([
			{ owner: "pages", items: [{ id: 11, title: "About", path: "/about" }] },
		]);
		expect(outcome.badUsage).toEqual([]);
		expect(seen).toEqual(["pages.delete-pages"]);
	});
});

describe("RichTextElementKindLive without ElementKinds", () => {
	it("builds cleanly and registers nothing when the registry is absent", async () => {
		const db = makeDb(makeD1(RICH_TEXT_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const services = Layer.merge(RichTextsLive, RichTextDeleteHooksLive);
		const app = RichTextElementKindLive.pipe(Layer.provideMerge(services), Layer.provide(deps));
		const absent = await Effect.runPromise(
			Effect.gen(function* () {
				const kinds = yield* Effect.serviceOption(ElementKinds);
				return Option.isNone(kinds);
			}).pipe(Effect.provide(app)),
		);
		expect(absent).toBe(true);
	});
});
