import { UsersIcon } from "lucide-react";
import type { JsonObject } from "effect/Schema";

import { definePlugin, type Plugin, type PluginContribution } from "@ktb/kernel";

import { PatientsPlatformPage } from "./platform-page.tsx";
import { PatientsDashboardStats } from "./views/PatientsDashboard.tsx";

/**
 * Client-safe mirror of ./index.ts — discovered by the browser bundle
 * through `@ktb/app-host/client` (import.meta.glob on
 * `plugins/<name>/src/client.ts`). Every server entry keeps its id and dep
 * edges so topo order matches the server registry, but only
 * client-consumed contributions are carried: chrome regions (console
 * sidebar) and panel pages. `panel.pages` keep id/path/component only — the
 * loader Effect runs server-side and stays in ./index.ts.
 * tables/services/routes degrade to markers. Dep ids are literals:
 * importing ./index.ts would pull the server graph into the client
 * bundle. Keep in sync — parity is asserted by apps/web/src/plugins.test.ts.
 */
export const patientsChromePlugin = definePlugin({
	id: "patients.chrome",
	meta: { keywords: ["patients", "ui"] },
	requiredDeps: ["platform.panel"],
	chrome: [
		{
			id: "patients.sidebar",
			region: "portal.sidebar",
			content: {
				kind: "sidebarItem",
				item: {
					to: "/platform/patients",
					label: "Patients",
					icon: UsersIcon,
					group: "Clinical data",
				},
			},
		},
		// Mirrors patientsChromePlugin's dashboard slot (server index.ts).
		{
			id: "patients.dashboard.stats",
			region: "portal.dashboard.stats",
			when: { paths: ["/platform"] },
			content: { kind: "component", component: PatientsDashboardStats },
		},
	],
});

export const patientsPanelPlugin = definePlugin({
	id: "patients.panel",
	requiredDeps: ["platform.panel"],
	meta: {
		keywords: ["patients", "ui"],
		name: "Patients",
		description: "Patient records and demographics",
		icon: UsersIcon,
	},
	panel: {
		pages: [
			{
				id: "patients.admin",
				path: "/platform/patients",
				component: PatientsPlatformPage,
			},
		],
	},
});

/**
 * `patients.intake` mirror — the def entries are JSON data the browser
 * consumes: the wizard runner (`/wizards/patient-intake`), the view
 * page (`/v/patients-intake`) and the API exposure all resolve defs
 * from THIS registry via `collectKindContributions`.
 *
 * The metas below are VERBATIM copies of the defs in ./intake.ts —
 * kind/id/version replicate what the server builders emit in
 * ./index.ts (`documentCollectionContribution`/`wizardDefContribution`/
 * `viewDefContribution`/`apiExposureContribution`). The client-contract
 * arch rule bans value-imports of ./intake.ts here (it must stay free
 * of runtime imports so this file can ship to the browser bundle), so
 * the JSON is duplicated by hand; src/intake.test.ts asserts the two
 * manifests stay `toEqual`-identical. The WizardHooks services layer
 * never reaches the client — mirrors of `services` are omitted like
 * every other plugin.
 */
const defContribution = (
	kind: string,
	id: string,
	meta: unknown,
	version?: string,
): PluginContribution => ({
	kind,
	id,
	...(version === undefined ? {} : { version }),
	meta: meta as JsonObject,
});

const INTAKE_COLLECTION = "patients.intake";

const intakeCollectionMeta = {
	name: INTAKE_COLLECTION,
	version: 1,
	fields: {
		fullName: { kind: "string", required: true, maxLength: 200 },
		birthDate: {
			kind: "string",
			required: true,
			pattern: "^\\d{4}-\\d{2}-\\d{2}$",
			maxLength: 10,
		},
		phone: { kind: "string", maxLength: 40 },
		email: {
			kind: "string",
			maxLength: 200,
			pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
		},
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
	},
	indexes: ["fullName"],
};

const intakeWizardMeta = {
	id: "patient-intake",
	title: "Anamnese pré-consulta",
	description:
		"Conte um pouco sobre você e o motivo da consulta antes do atendimento. Suas respostas ficam registradas no seu prontuário.",
	permission: "patient.create",
	submitLabel: "Continuar",
	steps: [
		{
			kind: "form",
			id: "identity",
			title: "Seus dados",
			description: "Como podemos te identificar e entrar em contato.",
			schema: {
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
						pattern: "^\\d{4}-\\d{2}-\\d{2}$",
						maxLength: 10,
					},
					phone: { type: "string", title: "Telefone", maxLength: 40 },
					email: {
						type: "string",
						title: "E-mail",
						maxLength: 200,
						pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
					},
				},
				required: ["fullName", "birthDate"],
				additionalProperties: false,
			},
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
			schema: {
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
			},
			ui: {
				chiefComplaint: { widget: "textarea" },
				symptomsDuration: {
					options: [
						{ value: "<1w", label: "Menos de 1 semana" },
						{ value: "1-4w", label: "De 1 a 4 semanas" },
						{ value: "1-6m", label: "De 1 a 6 meses" },
						{ value: "6m+", label: "Mais de 6 meses" },
					],
				},
			},
		},
		{
			kind: "form",
			id: "history",
			title: "Histórico",
			description: "Medicamentos e alergias ajudam o profissional a te atender com segurança.",
			schema: {
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
			},
		},
		{
			kind: "form",
			id: "consent",
			title: "Consentimento",
			schema: {
				type: "object",
				properties: {
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
			},
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
	completion: { kind: "hook", hook: "patients.intake.submit" },
};

const intakeViewMeta = {
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
		{
			field: "dataUseConsent",
			label: "patients.intake.dataUseConsent",
			format: "boolean",
		},
	],
	filters: [
		{ field: "chiefComplaint", op: "$regex", label: "Motivo da consulta" },
		{ field: "symptomsDuration", op: "$eq", label: "Tempo dos sintomas" },
	],
	sort: [{ field: "fullName", dir: "asc" }],
	pageSize: 25,
};

const intakeExposureMeta = {
	collection: INTAKE_COLLECTION,
	permission: "patient.read",
};

export const patientsIntakePlugin = definePlugin({
	id: "patients.intake",
	meta: { keywords: ["patients", "documents"] },
	// Literal ids mirror patientsIntakePlugin.optionalDeps (server
	// index.ts) — importing the server modules would pull the server
	// graph into the client bundle.
	optionalDeps: ["wizards.services", "document-store.services"],
	contributions: [
		defContribution("document.collection", INTAKE_COLLECTION, intakeCollectionMeta, "1"),
		defContribution("wizard.def", "patient-intake", intakeWizardMeta),
		defContribution("view.def", "patients-intake", intakeViewMeta, "1"),
		defContribution("api.expose", INTAKE_COLLECTION, intakeExposureMeta, "1"),
	],
});

/** Single-concern plugins contributed by this module — the client
 * discovery contract (`discoverPlugins` reads this export). */
export const plugins: readonly Plugin[] = [
	definePlugin({ id: "patients.tables", meta: { keywords: ["patients", "tables"] } }),
	definePlugin({
		id: "patients.services",
		meta: { keywords: ["patients", "services"] },
		requiredDeps: ["platform.admin"],
		// Mirrors patientsServicesPlugin.optionalDeps (server index.ts).
		optionalDeps: ["audit.services", "vault.services"],
	}),
	definePlugin({ id: "patients.routes", meta: { keywords: ["patients", "routes"] } }),
	patientsChromePlugin,
	patientsPanelPlugin,
	patientsIntakePlugin,
];
