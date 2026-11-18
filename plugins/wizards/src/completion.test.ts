import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { DocumentStore, type DocumentStoreShape } from "@ktb/document-store";

import { CompletionFailed, resolveCompletionData, runCompletion } from "./completion.ts";
import type { CompletionContext } from "./completion.ts";
import type { WizardDefinition } from "./definition.ts";
import { WizardHooks, WizardHooksLive } from "./hooks.ts";

const definition: WizardDefinition = {
	id: "w",
	title: "Wizard",
	steps: [{ kind: "info", id: "s" }],
};

const ctx: CompletionContext = {
	run: { id: 7, key: "w", ownerId: "u1" },
	definition,
	answers: { contact: { email: "a@b.c" }, plain: 42 },
};

const docCompletion = {
	kind: "document-store" as const,
	collection: "intakes",
	data: {
		email: "$answers.contact.email",
		literal: "static",
		num: 7,
		missing: "$answers.nope.deeper",
		alien: "$bogus.path",
		wizardId: "$wizard.id",
		runKey: "$run.key",
	},
};

describe("resolveCompletionData", () => {
	it("expands $-templates and passes literals through", () => {
		expect(resolveCompletionData(docCompletion.data, ctx)).toEqual({
			email: "a@b.c",
			literal: "static",
			num: 7,
			missing: "$answers.nope.deeper", // unresolved templates stay literal
			alien: "$bogus.path", // unknown template root stays literal too
			wizardId: "w",
			runKey: "w",
		});
		expect(resolveCompletionData(undefined, ctx)).toEqual({});
	});
});

describe("runCompletion", () => {
	it("returns null payload when no completion is set", async () => {
		await expect(
			Effect.runPromise(runCompletion(undefined, ctx).pipe(Effect.provide(WizardHooksLive))),
		).resolves.toBeNull();
	});

	it("writes a document-store record with owner attribution", async () => {
		const inserted: Array<{ collection: unknown; data: unknown; ctx: unknown }> = [];
		const store: DocumentStoreShape = {
			ensureCollection: () => Effect.die("unused"),
			insert: ((collection: unknown, data: unknown, c: unknown) =>
				Effect.sync(() => {
					inserted.push({ collection, data, ctx: c });
					return {} as never;
				})) as DocumentStoreShape["insert"],
			get: () => Effect.die("unused"),
			find: () => Effect.die("unused"),
			update: () => Effect.die("unused"),
			delete: () => Effect.die("unused"),
			batch: () => Effect.die("unused"),
			migrateCollection: () => Effect.die("unused"),
		};
		const payload = await Effect.runPromise(
			runCompletion(docCompletion, ctx).pipe(
				Effect.provide(Layer.succeed(DocumentStore, store)),
				Effect.provide(WizardHooksLive),
			),
		);
		expect(payload).toEqual({
			email: "a@b.c",
			literal: "static",
			num: 7,
			missing: "$answers.nope.deeper",
			alien: "$bogus.path",
			wizardId: "w",
			runKey: "w",
		});
		expect(inserted).toHaveLength(1);
		expect(inserted[0]?.collection).toBe("intakes");
		expect(inserted[0]?.ctx).toEqual({ ownerId: "u1" });
	});

	it("fails CompletionFailed when DocumentStore is absent", async () => {
		const error = await Effect.runPromise(
			Effect.flip(runCompletion(docCompletion, ctx).pipe(Effect.provide(WizardHooksLive))),
		);
		expect(error).toBeInstanceOf(CompletionFailed);
		expect((error as CompletionFailed).reason).toContain("DocumentStore");
	});

	it("maps insert failures to CompletionFailed", async () => {
		const store = {
			insert: () => Effect.fail({ _tag: "UnknownCollection" }),
		} as unknown as DocumentStoreShape;
		const error = await Effect.runPromise(
			Effect.flip(
				runCompletion(docCompletion, ctx).pipe(
					Effect.provide(Layer.succeed(DocumentStore, store)),
					Effect.provide(WizardHooksLive),
				),
			),
		);
		expect(error).toBeInstanceOf(CompletionFailed);
		expect((error as CompletionFailed).reason).toContain("intakes");
	});

	it("invokes a registered hook with the run handle", async () => {
		let seen: unknown = null;
		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const hooks = yield* WizardHooks;
				hooks.register("notify", (run) =>
					Effect.sync(() => {
						seen = run;
						return "sent";
					}),
				);
				return yield* runCompletion(
					{ kind: "hook", hook: "notify", data: { who: "$answers.contact.email" } },
					ctx,
				);
			}).pipe(Effect.provide(WizardHooksLive)),
		);
		expect(result).toEqual({ who: "a@b.c" });
		expect(seen).toMatchObject({
			id: 7,
			key: "w",
			ownerId: "u1",
			payload: { who: "a@b.c" },
		});
	});

	it("fails CompletionFailed for unknown hooks and hook errors", async () => {
		const missing = await Effect.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const hooks = yield* WizardHooks;
					hooks.register("bad", () => Effect.fail(new Error("boom")));
					return yield* runCompletion({ kind: "hook", hook: "missing" }, ctx);
				}).pipe(Effect.provide(WizardHooksLive)),
			),
		);
		expect(missing).toBeInstanceOf(CompletionFailed);
		expect((missing as CompletionFailed).reason).toContain('hook "missing" failed');

		const failing = await Effect.runPromise(
			Effect.flip(
				Effect.gen(function* () {
					const hooks = yield* WizardHooks;
					hooks.register("bad", () => Effect.fail(new CompletionFailed({ reason: "inner" })));
					return yield* runCompletion({ kind: "hook", hook: "bad" }, ctx);
				}).pipe(Effect.provide(WizardHooksLive)),
			),
		);
		expect(failing).toBeInstanceOf(CompletionFailed);
		expect((failing as CompletionFailed).reason).toContain('hook "bad" failed');
	});
});
