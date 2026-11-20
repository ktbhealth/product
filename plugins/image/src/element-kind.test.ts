import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { makePlatformAdminGate, parsePlatformAdminEmails, PlatformAdmin } from "@ktb/platform";
import { ElementKinds, ElementKindsLive } from "@ktb/platform/element-kinds";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";

import { images } from "./schema.ts";
import { ImageDeleteHooks, ImageDeleteHooksLive } from "./delete-hooks.ts";
import { ImageElementKindLive, IMAGE_ELEMENT_KIND } from "./element-kind.ts";
import { ImagesLive, IMAGES_TEST_DDL } from "./service.ts";

/**
 * Element-kind registration (P-111): `ImageElementKindLive` registers
 * the "image" descriptor into the shared `ElementKinds` registry at
 * layer build — when the registry is provided (the app-host `core`
 * contract) — and builds cleanly without it (serviceOption absent
 * path). The composed layer mirrors the plugin's `services` field:
 * provideMerge wires the sibling Images/ImageDeleteHooks services the
 * descriptor resolves through.
 */

describe("ImageElementKindLive", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	let db: ReturnType<typeof makeDb>;
	let imageId: number;

	beforeAll(async () => {
		db = makeDb(makeD1(IMAGES_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		// Mirror the app-host composition: `core` (ElementKinds + infra)
		// is merged at top level AND provided into the plugin layer —
		// the same layer object, so the registry instance is shared.
		const core = Layer.mergeAll(ElementKindsLive, deps);
		const services = Layer.merge(ImagesLive, ImageDeleteHooksLive);
		const composed = ImageElementKindLive.pipe(Layer.provideMerge(services));
		const app = Layer.mergeAll(core, composed.pipe(Layer.provide(core)));
		runtime = ManagedRuntime.make(app as Layer.Layer<unknown, never, never>);
		const rows = await db
			.insert(images)
			.values({
				title: "Hero",
				alt: "Hero alt",
				mime: "image/png",
				size: 1234,
				storageKey: "images/hero.png",
				width: 640,
				height: 480,
				createdAt: new Date(),
			})
			.returning({ id: images.id });
		imageId = rows[0]!.id;
	});

	afterAll(() => runtime.dispose());

	it("registers the image descriptor into ElementKinds", async () => {
		const kind = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				return kinds.get(IMAGE_ELEMENT_KIND);
			}),
		);
		expect(kind?.kind).toBe("image");
		expect(kind?.label).toBe("Image");
		expect(kind?.resolve).toBeTypeOf("function");
		expect(kind?.hooks?.usage).toBeTypeOf("function");
		expect(kind?.hooks?.cleanup).toBeTypeOf("function");
	});

	it("resolve maps a ref to the renderable payload", async () => {
		const payload = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				return yield* kinds.get(IMAGE_ELEMENT_KIND)!.resolve({ imageId, fit: "cover" });
			}),
		);
		expect(payload).toEqual({
			src: `/api/images/${imageId}`,
			alt: "Hero alt",
			title: "Hero",
			width: 640,
			height: 480,
			mime: "image/png",
			fit: "cover",
		});
	});

	it("resolve honors the ref's alt override and tolerates bare ids", async () => {
		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				const resolve = kinds.get(IMAGE_ELEMENT_KIND)!.resolve;
				return [
					yield* resolve({ imageId, alt: "Placement alt" }),
					yield* resolve(imageId),
				] as const;
			}),
		);
		expect((results[0] as { alt: string }).alt).toBe("Placement alt");
		expect((results[1] as { alt: string }).alt).toBe("Hero alt");
		expect((results[1] as { fit: string | null }).fit).toBeNull();
	});

	it("resolve returns null for missing rows and malformed refs", async () => {
		const results = await runtime.runPromise(
			Effect.gen(function* () {
				const kinds = yield* ElementKinds;
				const resolve = kinds.get(IMAGE_ELEMENT_KIND)!.resolve;
				return [
					yield* resolve({ imageId: 999_999 }),
					yield* resolve("not-a-number"),
					yield* resolve(0),
					yield* resolve(-3),
					yield* resolve(1.5),
					yield* resolve(null),
					yield* resolve({}),
				];
			}),
		);
		expect(results).toEqual([null, null, null, null, null, null, null]);
	});

	it("hooks.usage/cleanup delegate to the ImageDeleteHooks registry", async () => {
		const seen: string[] = [];
		const outcome = await runtime.runPromise(
			Effect.gen(function* () {
				const hooks = yield* ImageDeleteHooks;
				yield* hooks.register({
					id: "builder",
					usage: () => Effect.succeed([{ id: 11, title: "Hero block", path: "/" }]),
					// Real hooks no-op on action ids they don't own — the
					// stub honors the same contract.
					cleanup: (_imageId, actionId) =>
						actionId.startsWith("builder.")
							? Effect.sync(() => {
									seen.push(actionId);
								})
							: Effect.void,
				});
				const kinds = yield* ElementKinds;
				const kindHooks = kinds.get(IMAGE_ELEMENT_KIND)!.hooks!;
				const usage = yield* kindHooks.usage!({ imageId });
				// Foreign action ids are a silent no-op; owned ones run.
				yield* kindHooks.cleanup!({ imageId }, "unrelated.action");
				yield* kindHooks.cleanup!({ imageId }, "builder.unlink");
				// Malformed refs resolve to empty/no-op, never throw.
				const badUsage = yield* kindHooks.usage!("nope");
				yield* kindHooks.cleanup!(null, "builder.unlink");
				return { usage, badUsage };
			}),
		);
		expect(outcome.usage).toEqual([
			{ owner: "builder", items: [{ id: 11, title: "Hero block", path: "/" }] },
		]);
		expect(outcome.badUsage).toEqual([]);
		expect(seen).toEqual(["builder.unlink"]);
	});
});

describe("ImageElementKindLive without ElementKinds", () => {
	it("builds cleanly and registers nothing when the registry is absent", async () => {
		const db = makeDb(makeD1(IMAGES_TEST_DDL));
		const deps = Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
		const services = Layer.merge(ImagesLive, ImageDeleteHooksLive);
		const app = ImageElementKindLive.pipe(Layer.provideMerge(services), Layer.provide(deps));
		const absent = await Effect.runPromise(
			Effect.gen(function* () {
				const kinds = yield* Effect.serviceOption(ElementKinds);
				return Option.isNone(kinds);
			}).pipe(Effect.provide(app)),
		);
		expect(absent).toBe(true);
	});
});
