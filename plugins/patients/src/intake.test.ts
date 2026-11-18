import { describe, expect, it, vi } from "vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { collectApiExposures } from "@ktb/api";
import {
	collectDocumentCollections,
	DocumentStore,
	type DocumentStoreShape,
} from "@ktb/document-store";
import { collectViewDefinitions } from "@ktb/views";
import {
	collectWizardDefinitions,
	WizardHooks,
	WizardHooksLive,
	type WizardRunHandle,
} from "@ktb/wizards";

import {
	INTAKE_COLLECTION,
	INTAKE_SUBMIT_HOOK,
	INTAKE_WIZARD_ID,
	intakeSubmissionFromAnswers,
	intakeWizard,
} from "./intake.ts";
import { PatientsIntakeHooksLive, patientsIntakePlugin, plugins } from "./index.ts";
import { patientsIntakePlugin as clientIntakePlugin } from "./client.ts";

const runHandle = (overrides: Partial<WizardRunHandle> = {}): WizardRunHandle => ({
	id: 1,
	key: INTAKE_WIZARD_ID,
	ownerId: "u1",
	definition: intakeWizard,
	answers: {},
	payload: {},
	...overrides,
});

describe("patients.intake defs", () => {
	it("collects the document collection with the plugin as owner", () => {
		const collections = collectDocumentCollections([patientsIntakePlugin]);
		expect(collections).toHaveLength(1);
		expect(collections[0]?.name).toBe(INTAKE_COLLECTION);
		expect(collections[0]?.owner).toBe("patients.intake");
		expect(Object.keys(collections[0]?.fields ?? {})).toEqual([
			"fullName",
			"birthDate",
			"phone",
			"email",
			"chiefComplaint",
			"symptomsDuration",
			"medications",
			"allergies",
			"termsAccepted",
			"dataUseConsent",
		]);
	});

	it("collects the wizard definition", () => {
		const wizards = collectWizardDefinitions([patientsIntakePlugin]);
		expect(wizards).toHaveLength(1);
		expect(wizards[0]?.id).toBe(INTAKE_WIZARD_ID);
		expect(wizards[0]?.owner).toBe("patients.intake");
		expect(wizards[0]?.steps.map((s) => s.id)).toEqual([
			"identity",
			"complaint",
			"history",
			"consent",
			"review",
		]);
		expect(wizards[0]?.completion).toEqual({ kind: "hook", hook: INTAKE_SUBMIT_HOOK });
		expect(wizards[0]?.permission).toBe("patient.create");
	});

	it("collects the view and api exposure defs", () => {
		const views = collectViewDefinitions([patientsIntakePlugin]);
		expect(views).toHaveLength(1);
		expect(views[0]?.id).toBe("patients-intake");
		expect(views[0]?.collection).toBe(INTAKE_COLLECTION);
		expect(views[0]?.permission).toBe("patient.read");

		const exposures = collectApiExposures([patientsIntakePlugin]);
		expect(exposures).toHaveLength(1);
		expect(exposures[0]?.collection).toBe(INTAKE_COLLECTION);
		expect(exposures[0]?.permission).toBe("patient.read");
		expect(exposures[0]?.public).toBeUndefined();
	});

	it("mirrors every contribution verbatim in the client registry", () => {
		expect(clientIntakePlugin.id).toBe(patientsIntakePlugin.id);
		expect(clientIntakePlugin.optionalDeps).toEqual(patientsIntakePlugin.optionalDeps);
		expect(clientIntakePlugin.contributions).toEqual(patientsIntakePlugin.contributions);
	});

	it("is the last entry of the discovery plugins array", () => {
		expect(plugins.at(-1)?.id).toBe("patients.intake");
	});
});

describe("intakeSubmissionFromAnswers", () => {
	it("maps every step's answers onto collection fields", () => {
		const data = intakeSubmissionFromAnswers({
			identity: {
				fullName: "Ana Souza",
				birthDate: "1990-05-20",
				phone: "11999990000",
				email: "ana@exemplo.com",
			},
			complaint: { chiefComplaint: "Dor de cabeça frequente", symptomsDuration: "1-4w" },
			history: { medications: ["Losartana"], allergies: ["Dipirona"] },
			consent: { termsAccepted: true, dataUseConsent: true },
			review: undefined,
		});
		expect(data).toEqual({
			fullName: "Ana Souza",
			birthDate: "1990-05-20",
			phone: "11999990000",
			email: "ana@exemplo.com",
			chiefComplaint: "Dor de cabeça frequente",
			symptomsDuration: "1-4w",
			medications: ["Losartana"],
			allergies: ["Dipirona"],
			termsAccepted: true,
			dataUseConsent: true,
		});
	});

	it("omits absent optional answers instead of writing template literals", () => {
		const data = intakeSubmissionFromAnswers({
			identity: { fullName: "Ana", birthDate: "1990-05-20" },
			complaint: { chiefComplaint: "Náusea", symptomsDuration: "<1w" },
			consent: { termsAccepted: true },
		});
		expect(data).toEqual({
			fullName: "Ana",
			birthDate: "1990-05-20",
			chiefComplaint: "Náusea",
			symptomsDuration: "<1w",
			termsAccepted: true,
		});
		expect(Object.values(data)).not.toContain("$answers.identity.phone");
	});

	it("skips non-object step values and undefined fields", () => {
		const data = intakeSubmissionFromAnswers({
			identity: "forged",
			complaint: null,
			history: [1, 2],
			consent: { termsAccepted: undefined, dataUseConsent: false },
		});
		expect(data).toEqual({ dataUseConsent: false });
	});
});

describe("PatientsIntakeHooksLive", () => {
	const fakeStore = (insert: ReturnType<typeof vi.fn>) =>
		({ insert }) as unknown as DocumentStoreShape;

	/** Build the hook registry with the intake layer + optional ports.
	 * Mirrors app-host composition: earlier outputs are provided into
	 * the intake layer via provideMerge (mergeAll alone does NOT wire
	 * siblings' outputs into each other's serviceOption lookups). */
	const makeHooks = (
		store?: DocumentStoreShape,
	): Effect.Effect<WizardHooks["Service"], never, never> => {
		const ports = Layer.mergeAll(
			WizardHooksLive,
			...(store === undefined ? [] : [Layer.succeed(DocumentStore, store)]),
		);
		return Effect.scoped(
			Layer.build(Layer.merge(ports, PatientsIntakeHooksLive.pipe(Layer.provideMerge(ports)))),
		).pipe(Effect.map((ctx) => Context.get(ctx, WizardHooks)));
	};

	it("registers the submit hook and inserts the mapped document", async () => {
		const insert = vi.fn(() => Effect.succeed({ id: 7 }));
		const hooks = await Effect.runPromise(makeHooks(fakeStore(insert)));
		expect(hooks.get(INTAKE_SUBMIT_HOOK)).toBeDefined();
		await Effect.runPromise(
			hooks.invoke(
				INTAKE_SUBMIT_HOOK,
				runHandle({
					answers: {
						identity: { fullName: "Ana", birthDate: "1990-05-20" },
						complaint: { chiefComplaint: "Náusea", symptomsDuration: "<1w" },
						consent: { termsAccepted: true },
					},
				}),
			),
		);
		expect(insert).toHaveBeenCalledWith(
			INTAKE_COLLECTION,
			{
				fullName: "Ana",
				birthDate: "1990-05-20",
				chiefComplaint: "Náusea",
				symptomsDuration: "<1w",
				termsAccepted: true,
			},
			{ ownerId: "u1" },
		);
	});

	it("fails when the hook is invoked for a different wizard", async () => {
		const insert = vi.fn(() => Effect.succeed({ id: 7 }));
		const hooks = await Effect.runPromise(makeHooks(fakeStore(insert)));
		const exit = await Effect.runPromiseExit(
			hooks.invoke(INTAKE_SUBMIT_HOOK, runHandle({ key: "other-wizard" })),
		);
		expect(exit._tag).toBe("Failure");
		expect(insert).not.toHaveBeenCalled();
	});

	it("fails loudly when DocumentStore is absent", async () => {
		const hooks = await Effect.runPromise(makeHooks());
		const exit = await Effect.runPromiseExit(hooks.invoke(INTAKE_SUBMIT_HOOK, runHandle()));
		expect(exit._tag).toBe("Failure");
	});

	it("builds cleanly without the WizardHooks service", async () => {
		const ports = Layer.succeed(DocumentStore, fakeStore(vi.fn()));
		const layer = Layer.merge(ports, PatientsIntakeHooksLive.pipe(Layer.provideMerge(ports)));
		await expect(Effect.runPromise(Effect.scoped(Layer.build(layer)))).resolves.toBeDefined();
	});
});
