import { paramMessage } from "@ktb/i18n";

/**
 * Forms plugin copy, one typed catalog per locale — same contract as
 * plugins/document-store/src/i18n.ts: plugins cannot import the host's
 * Paraglide output, so surfaces resolve strings here from the active
 * locale (PageContext.locale / SchemaForm `messages` prop). A locale
 * catalog must implement `FormMessages` in full.
 */

export const FORMS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "forms";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): FormMessages => formsMessages(locale);
export type FormsLocale = (typeof FORMS_LOCALES)[number];
const BASE_LOCALE: FormsLocale = "en";

export interface FormMessages {
	/** Submit button label (definition.submitLabel overrides). */
	readonly submit: string;
	/** Empty-state copy on /forms/<id> when no def matches. */
	readonly notFoundTitle: string;
	readonly notFoundDescription: string;
	/** Summary banner after a failed submit — param is the issue count. */
	readonly invalidSummary: (count: number) => string;
	/** Label for the empty option of select/radio widgets. */
	readonly chooseOption: string;
	/** Add/remove controls of the array ("list") widget. */
	readonly addItem: string;
	readonly removeItem: string;
	/** Shown on /forms/<id> after a successful submit — the standalone
	 * page is a preview host; defs embedded via SchemaForm get a real
	 * onSubmit from their owner plugin instead. */
	readonly submittedPreview: string;
}

const en: FormMessages = {
	submit: "Submit",
	notFoundTitle: "Form not found",
	notFoundDescription: "No form is published at this address.",
	invalidSummary: paramMessage(
		"en",
		"{count, plural, one {# problem needs attention} other {# problems need attention}}",
		["count"],
	),
	chooseOption: "Choose…",
	addItem: "Add item",
	removeItem: "Remove item",
	submittedPreview: "Submission validated — this is a preview, nothing was sent.",
};

const ptBR: FormMessages = {
	submit: "Enviar",
	notFoundTitle: "Formulário não encontrado",
	notFoundDescription: "Nenhum formulário está publicado neste endereço.",
	invalidSummary: paramMessage(
		"pt-BR",
		"{count, plural, one {# problema precisa de atenção} other {# problemas precisam de atenção}}",
		["count"],
	),
	chooseOption: "Escolha…",
	addItem: "Adicionar item",
	removeItem: "Remover item",
	submittedPreview: "Envio validado — esta é uma prévia, nada foi enviado.",
};

const es: FormMessages = {
	submit: "Enviar",
	notFoundTitle: "Formulario no encontrado",
	notFoundDescription: "No hay ningún formulario publicado en esta dirección.",
	invalidSummary: paramMessage(
		"es",
		"{count, plural, one {# problema necesita atención} other {# problemas necesitan atención}}",
		["count"],
	),
	chooseOption: "Elige…",
	addItem: "Añadir elemento",
	removeItem: "Quitar elemento",
	submittedPreview: "Envío validado — esto es una vista previa, no se envió nada.",
};

const CATALOGS: Record<FormsLocale, FormMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isFormsLocale = (locale: string): locale is FormsLocale =>
	(FORMS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const formsMessages = (locale: string | undefined): FormMessages =>
	CATALOGS[isFormsLocale(locale ?? "") ? (locale as FormsLocale) : BASE_LOCALE];
