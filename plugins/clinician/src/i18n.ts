/**
 * Clinician plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale (`ctx.locale` on pages, `getLocale()` in fns) and copy
 * resolves here. A locale catalog must implement `ClinicianMessages`
 * in full — a missing key is a type error, not an English fallback at
 * runtime.
 */

export const CLINICIAN_LOCALES = ["en", "pt-BR", "es"] as const;
export type ClinicianLocale = (typeof CLINICIAN_LOCALES)[number];
export const BASE_LOCALE: ClinicianLocale = "en";

export interface ClinicianMessages {
	readonly home: {
		readonly title: string;
		readonly subtitle: string;
		readonly patientsTitle: string;
		readonly patientsDesc: string;
		readonly consultationsTitle: string;
		readonly consultationsDesc: string;
	};
}

const en: ClinicianMessages = {
	home: {
		title: "Clinician workspace",
		subtitle: "Patients and consultations for the doctor you act as.",
		patientsTitle: "Patients",
		patientsDesc: "Records, demographics and deletion.",
		consultationsTitle: "Consultations",
		consultationsDesc: "Visit notes, transcripts and anamnesis.",
	},
};

const ptBR: ClinicianMessages = {
	home: {
		title: "Área do clínico",
		subtitle: "Pacientes e consultas do médico que você representa.",
		patientsTitle: "Pacientes",
		patientsDesc: "Prontuários, dados demográficos e exclusão.",
		consultationsTitle: "Consultas",
		consultationsDesc: "Notas de visita, transcrições e anamnese.",
	},
};

const es: ClinicianMessages = {
	home: {
		title: "Espacio del clínico",
		subtitle: "Pacientes y consultas del médico que usted representa.",
		patientsTitle: "Pacientes",
		patientsDesc: "Registros, datos demográficos y eliminación.",
		consultationsTitle: "Consultas",
		consultationsDesc: "Notas de visita, transcripciones y anamnesis.",
	},
};

const CATALOGS: Record<ClinicianLocale, ClinicianMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isClinicianLocale = (locale: string): locale is ClinicianLocale =>
	(CLINICIAN_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const clinicianMessages = (locale: string): ClinicianMessages =>
	CATALOGS[isClinicianLocale(locale) ? locale : BASE_LOCALE];

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "clinician";

/** Manifest importer entrypoint (tools/gen-i18n-manifest.mjs). */
export const i18nMessagesFor = (locale: string): ClinicianMessages => clinicianMessages(locale);
