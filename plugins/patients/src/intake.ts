import type { ApiExposure } from "@ktb/api";
import type { DocumentCollection, FieldDescriptor } from "@ktb/document-store";
import type { ViewDef } from "@ktb/views";
import type { WizardDefinition, WizardFormStep } from "@ktb/wizards";

/**
 * Patient pre-consult intake — the first real consumer of the
 * dynamic-runtime stack (document.collection + wizard.def + view.def +
 * api.expose on one plugin manifest).
 *
 * CLIENT-SAFE MODULE: every import above is `import type` — this file
 * must stay free of runtime imports so `src/client.ts` can mirror the
 * defs into the browser registry without pulling the server graph
 * (services, drizzle, Effect layers) into the client bundle. The
 * server side (./index.ts) re-validates these literals through the
 * `define*`/`assert*` builders at module load; the client mirror
 * carries the same JSON verbatim.
 *
 * Design notes:
 * - `birthDate` is a `string` field holding an ISO `YYYY-MM-DD` date,
 *   NOT the document-store `date` kind (epoch ms): @ktb/forms
 *   SchemaForm has no date widget — the value arrives as a string —
 *   and wizard completion templates cannot convert ISO → epoch ms.
 *   The pattern constraint keeps the stored shape honest.
 * - The wizard completes through a `hook` target
 *   ({@link INTAKE_SUBMIT_HOOK}), not `document-store`: template
 *   resolution passes UNRESOLVED `$answers.*` paths through literally,
 *   so optional fields left blank would store the literal string
 *   "$answers.identity.phone". The hook handler (./index.ts) maps
 *   answers → collection fields and drops absent optionals before
 *   calling `DocumentStore.insert` — the write still lands in
 *   `patients.intake` through the same validation path.
 * - Copy is pt-BR literals: wizard defs have no i18n-key resolution
 *   (the runner renders def strings verbatim — see
 *   plugins/wizards/src/views/WizardRunner.tsx). View titles/labels
 *   DO resolve `namespace.key` catalog entries, so the view def uses
 *   `patients.*` i18n keys declared in ./i18n.ts.
 */

/** Collection name — shared by the def, the hook handler and tests. */
export const INTAKE_COLLECTION = "patients.intake";

/** Wizard id — the `/wizards/<id>` segment. */
export const INTAKE_WIZARD_ID = "patient-intake";

/** WizardHooks id the completion target invokes — registered by the
 * patients.intake services layer (./index.ts). */
export const INTAKE_SUBMIT_HOOK = "patients.intake.submit";

const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";
const EMAIL_PATTERN = "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$";

/** Collection field map — see ./fields.ts kinds. `birthDate` stays a
 * string for the reason in the module docstring. */
const intakeFields: Record<string, FieldDescriptor> = {
	fullName: { kind: "string", required: true, maxLength: 200 },
	birthDate: { kind: "string", required: true, pattern: ISO_DATE_PATTERN, maxLength: 10 },
	phone: { kind: "string", maxLength: 40 },
	email: { kind: "string", maxLength: 200, pattern: EMAIL_PATTERN },
	chiefComplaint: { kind: "string", required: true, maxLength: 4000 },
	symptomsDuration: {
		kind: "enum",
		values: ["<1w", "1-4w", "1-6m", "6m+"],
		required: true,
	},
	medications: {
		kind: "array",
		of: { kind: "string", maxLength: 200 },
		maxLength: 50,
	},
	allergies: {
		kind: "array",
		of: { kind: "string", maxLength: 200 },
		maxLength: 50,
	},
	termsAccepted: { kind: "boolean", required: true },
	dataUseConsent: { kind: "boolean" },
};

/** `document.collection` def — submitted intake records. */
export const intakeCollection: DocumentCollection = {
	name: INTAKE_COLLECTION,
	version: 1,
	fields: intakeFields,
	indexes: ["fullName"],
};

type StepSchema = WizardFormStep["schema"];

const identitySchema: StepSchema = {
	type: "object",
	properties: {
		fullName: {
			type: "string",
			title: "Nome completo",
			minLength: 1,
			maxLength: 200,
		},
		birthDate: {
			type: "string",
			title: "Data de nascimento",
			description: "Formato AAAA-MM-DD.",
			pattern: ISO_DATE_PATTERN,
			maxLength: 10,
		},
		phone: { type: "string", title: "Telefone", maxLength: 40 },
		email: {
			type: "string",
			title: "E-mail",
			maxLength: 200,
			pattern: EMAIL_PATTERN,
		},
	},
	required: ["fullName", "birthDate"],
	additionalProperties: false,
};

const complaintSchema: StepSchema = {
	type: "object",
	properties: {
		chiefComplaint: {
			type: "string",
			title: "Motivo da consulta",
			description: "Descreva com suas palavras o que o leva à consulta.",
			minLength: 1,
			maxLength: 4000,
		},
		symptomsDuration: {
			type: "string",
			title: "Há quanto tempo",
			description: "Há quanto tempo os sintomas estão presentes?",
			enum: ["<1w", "1-4w", "1-6m", "6m+"],
		},
	},
	required: ["chiefComplaint", "symptomsDuration"],
	additionalProperties: false,
};

const historySchema: StepSchema = {
	type: "object",
	properties: {
		medications: {
			type: "array",
			title: "Medicamentos em uso",
			description: "Medicamentos de uso contínuo ou frequente. Deixe vazio se não houver.",
			items: { type: "string", maxLength: 200 },
			maxItems: 50,
			default: [],
		},
		allergies: {
			type: "array",
			title: "Alergias",
			description:
				"Alergias a medicamentos, alimentos ou outras substâncias. Deixe vazio se não houver.",
			items: { type: "string", maxLength: 200 },
			maxItems: 50,
			default: [],
		},
	},
	additionalProperties: false,
};

const consentSchema: StepSchema = {
	type: "object",
	properties: {
		// `const: true` is the subset's only "must be checked" spelling;
		// the forced `checkbox` ui hint keeps the boolean widget (enum/
		// const would otherwise infer `select`). Unchecked submits
		// `false`, which fails `const` and surfaces a field error.
		termsAccepted: {
			const: true,
			title: "Li e aceito os termos de uso e a política de privacidade do serviço.",
		},
		dataUseConsent: {
			type: "boolean",
			title: "Autorizo o uso dos dados informados para organizar meu atendimento.",
		},
	},
	required: ["termsAccepted"],
	additionalProperties: false,
};

const durationOptions = [
	{ value: "<1w", label: "Menos de 1 semana" },
	{ value: "1-4w", label: "De 1 a 4 semanas" },
	{ value: "1-6m", label: "De 1 a 6 meses" },
	{ value: "6m+", label: "Mais de 6 meses" },
] as const;

/** `wizard.def` — 5-step pre-consult intake. Step ids key the run's
 * `answers` object; the hook handler maps them onto the collection
 * fields (see {@link intakeSubmissionFromAnswers}). */
export const intakeWizard: WizardDefinition = {
	id: INTAKE_WIZARD_ID,
	title: "Anamnese pré-consulta",
	description:
		"Conte um pouco sobre você e o motivo da consulta antes do atendimento. Suas respostas ficam registradas no seu prontuário.",
	// Same catalog grant as creating a patient record — the intake is
	// the front door to the patient chart (see plugins/rbac catalog).
	permission: "patient.create",
	submitLabel: "Continuar",
	steps: [
		{
			kind: "form",
			id: "identity",
			title: "Seus dados",
			description: "Como podemos te identificar e entrar em contato.",
			schema: identitySchema,
			ui: {
				birthDate: { placeholder: "1990-05-20" },
				phone: { placeholder: "(11) 99999-0000" },
				email: { placeholder: "voce@exemplo.com" },
			},
		},
		{
			kind: "form",
			id: "complaint",
			title: "Motivo da consulta",
			schema: complaintSchema,
			ui: {
				chiefComplaint: { widget: "textarea" },
				symptomsDuration: { options: durationOptions },
			},
		},
		{
			kind: "form",
			id: "history",
			title: "Histórico",
			description: "Medicamentos e alergias ajudam o profissional a te atender com segurança.",
			schema: historySchema,
		},
		{
			kind: "form",
			id: "consent",
			title: "Consentimento",
			schema: consentSchema,
			ui: {
				termsAccepted: { widget: "checkbox" },
			},
		},
		{
			kind: "info",
			id: "review",
			title: "Revisar e enviar",
			body: "Revise mentalmente as respostas dos passos anteriores. Ao continuar, suas respostas são registradas e ficam disponíveis para a equipe antes da consulta.",
		},
	],
	completion: { kind: "hook", hook: INTAKE_SUBMIT_HOOK },
};

/** `view.def` — staff browse table over submitted intakes at
 * `/v/patients-intake`. Title/field labels are `patients.*` catalog
 * keys (resolved via `ctx.i18n.catalog`); filter labels have no i18n
 * path in @ktb/views v1 and stay pt-BR literals. */
export const intakeView: ViewDef = {
	id: "patients-intake",
	title: "patients.intake.viewTitle",
	collection: INTAKE_COLLECTION,
	permission: "patient.read",
	kind: "table",
	fields: [
		{ field: "fullName", label: "patients.fields.name", width: "14rem" },
		{ field: "birthDate", label: "patients.fields.birthDate" },
		{ field: "phone", label: "patients.fields.phone" },
		{ field: "email", label: "patients.fields.email" },
		{ field: "chiefComplaint", label: "patients.intake.chiefComplaint", width: "18rem" },
		{
			field: "symptomsDuration",
			label: "patients.intake.symptomsDuration",
			format: "enum",
		},
		{ field: "medications", label: "patients.intake.medications", format: "json" },
		{ field: "allergies", label: "patients.intake.allergies", format: "json" },
		{ field: "termsAccepted", label: "patients.intake.termsAccepted", format: "boolean" },
		{ field: "dataUseConsent", label: "patients.intake.dataUseConsent", format: "boolean" },
	],
	filters: [
		{ field: "chiefComplaint", op: "$regex", label: "Motivo da consulta" },
		{ field: "symptomsDuration", op: "$eq", label: "Tempo dos sintomas" },
	],
	sort: [{ field: "fullName", dir: "asc" }],
	pageSize: 25,
};

/** `api.expose` — read-only HTTP surface (`list`/`get` defaults) for
 * staff integrations. NOT public: every request needs a session plus
 * the `patient.read` grant — intake records carry clinical detail
 * (chief complaint, medications, allergies). */
export const intakeExposure: ApiExposure = {
	collection: INTAKE_COLLECTION,
	permission: "patient.read",
};

/** (step id, answer field) → collection field. */
const ANSWER_MAP: ReadonlyArray<readonly [string, string, string]> = [
	["identity", "fullName", "fullName"],
	["identity", "birthDate", "birthDate"],
	["identity", "phone", "phone"],
	["identity", "email", "email"],
	["complaint", "chiefComplaint", "chiefComplaint"],
	["complaint", "symptomsDuration", "symptomsDuration"],
	["history", "medications", "medications"],
	["history", "allergies", "allergies"],
	["consent", "termsAccepted", "termsAccepted"],
	["consent", "dataUseConsent", "dataUseConsent"],
];

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Map a finished run's `answers` (step id → submitted step value)
 * onto `patients.intake` document fields. Absent answers are OMITTED
 * — never written as the literal `"$answers.*"` template strings the
 * document-store completion target would store for unresolved paths
 * (see module docstring). Values pass through raw; `DocumentStore.insert`
 * re-validates everything against the collection def, so forged or
 * stale answer shapes fail loudly instead of writing bad data.
 */
export const intakeSubmissionFromAnswers = (
	answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> => {
	const data: Record<string, unknown> = {};
	for (const [stepId, answerField, collectionField] of ANSWER_MAP) {
		const step = answers[stepId];
		if (!isPlainObject(step)) continue;
		const value = step[answerField];
		if (value !== undefined) data[collectionField] = value;
	}
	return data;
};
