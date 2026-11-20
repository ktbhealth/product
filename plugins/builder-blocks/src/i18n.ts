import { paramMessage } from "@ktb/i18n";

/**
 * Builder-blocks plugin copy, one typed catalog per locale — same
 * contract as plugins/forms/src/i18n.ts: plugins cannot import the
 * host's Paraglide output, so surfaces resolve strings here from the
 * active locale (PageContext.locale). A locale catalog must implement
 * `BuilderBlocksMessages` in full.
 */

export const BUILDER_BLOCKS_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "builder-blocks";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): BuilderBlocksMessages =>
	builderBlocksMessages(locale);

export type BuilderBlocksLocale = (typeof BUILDER_BLOCKS_LOCALES)[number];
const BASE_LOCALE: BuilderBlocksLocale = "en";

export interface BuilderBlocksMessages {
	/** /platform/components page chrome. */
	readonly title: string;
	readonly description: string;
	readonly searchPlaceholder: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	/** Category group headings (uncategorized kinds land under "other"). */
	readonly categoryLayout: string;
	readonly categoryContent: string;
	readonly categoryData: string;
	readonly categoryMedia: string;
	readonly categoryDomain: string;
	readonly categoryOther: string;
	/** Prop-schema panel copy. */
	readonly propsHeading: string;
	readonly noProps: string;
	readonly requiredMark: string;
	/** Live-preview frame label. */
	readonly previewLabel: string;
	/** Footer count under the grid — param is the kind count. */
	readonly kindCount: (count: number) => string;
}

const en: BuilderBlocksMessages = {
	title: "Components",
	description:
		"Element kinds registered by plugins — the building blocks the site builder palette offers.",
	searchPlaceholder: "Filter components…",
	emptyTitle: "No components found",
	emptyDescription: "No element kind matches the current filter.",
	categoryLayout: "Layout",
	categoryContent: "Content",
	categoryData: "Data",
	categoryMedia: "Media",
	categoryDomain: "Domain",
	categoryOther: "Other",
	propsHeading: "Props",
	noProps: "This kind has no editable props.",
	requiredMark: "required",
	previewLabel: "Preview",
	kindCount: paramMessage("en", "{count, plural, one {# component} other {# components}}", [
		"count",
	]),
};

const ptBR: BuilderBlocksMessages = {
	title: "Componentes",
	description:
		"Tipos de elemento registrados por plugins — os blocos que a paleta do construtor de sites oferece.",
	searchPlaceholder: "Filtrar componentes…",
	emptyTitle: "Nenhum componente encontrado",
	emptyDescription: "Nenhum tipo de elemento corresponde ao filtro atual.",
	categoryLayout: "Layout",
	categoryContent: "Conteúdo",
	categoryData: "Dados",
	categoryMedia: "Mídia",
	categoryDomain: "Domínio",
	categoryOther: "Outros",
	propsHeading: "Props",
	noProps: "Este tipo não tem props editáveis.",
	requiredMark: "obrigatório",
	previewLabel: "Prévia",
	kindCount: paramMessage("pt-BR", "{count, plural, one {# componente} other {# componentes}}", [
		"count",
	]),
};

const es: BuilderBlocksMessages = {
	title: "Componentes",
	description:
		"Tipos de elemento registrados por plugins — los bloques que la paleta del constructor de sitios ofrece.",
	searchPlaceholder: "Filtrar componentes…",
	emptyTitle: "No se encontraron componentes",
	emptyDescription: "Ningún tipo de elemento coincide con el filtro actual.",
	categoryLayout: "Diseño",
	categoryContent: "Contenido",
	categoryData: "Datos",
	categoryMedia: "Multimedia",
	categoryDomain: "Dominio",
	categoryOther: "Otros",
	propsHeading: "Props",
	noProps: "Este tipo no tiene props editables.",
	requiredMark: "obligatorio",
	previewLabel: "Vista previa",
	kindCount: paramMessage("es", "{count, plural, one {# componente} other {# componentes}}", [
		"count",
	]),
};

const CATALOGS: Record<BuilderBlocksLocale, BuilderBlocksMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isBuilderBlocksLocale = (locale: string): locale is BuilderBlocksLocale =>
	(BUILDER_BLOCKS_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const builderBlocksMessages = (locale: string | undefined): BuilderBlocksMessages =>
	CATALOGS[isBuilderBlocksLocale(locale ?? "") ? (locale as BuilderBlocksLocale) : BASE_LOCALE];
