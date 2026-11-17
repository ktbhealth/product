export const CRED_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4) — matches
 * the plugin-id domain (`eval.credentials.*` → `eval.credentials`). */
export const I18N_NAMESPACE = "eval.credentials";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): CredMessages => credMessages(locale);

export interface CredMessages {
	readonly title: string;
	readonly desc: string;
	readonly newCred: string;
	readonly name: string;
	readonly provider: string;
	readonly secret: string;
	readonly save: string;
	readonly cancel: string;
	readonly delete: string;
	readonly confirmDelete: string;
	readonly empty: string;
	readonly actionFailed: string;
}

const en: CredMessages = {
	title: "Credentials",
	desc: "Outbound secrets for AI providers — stored here, referenced by endpoints, never shown again.",
	newCred: "New credential",
	name: "Name",
	provider: "Provider",
	secret: "Secret",
	save: "Save",
	cancel: "Cancel",
	delete: "Delete",
	confirmDelete: "Confirm delete",
	empty: "No credentials yet — create one to use in endpoints.",
	actionFailed: "Action failed",
};

const ptBR: CredMessages = {
	...en,
	title: "Credenciais",
	desc: "Segredos de saída para provedores de IA — guardados aqui, referenciados pelos endpoints, nunca exibidos de novo.",
	newCred: "Nova credencial",
	provider: "Provedor",
	secret: "Segredo",
	delete: "Excluir",
	confirmDelete: "Confirmar exclusão",
	empty: "Nenhuma credencial ainda — crie uma para usar nos endpoints.",
	actionFailed: "Ação falhou",
};

const es: CredMessages = {
	...ptBR,
	...en,
	desc: "Secretos de salida para proveedores de IA — guardados aquí, referenciados por endpoints, nunca mostrados de nuevo.",
};

export const credMessages = (locale: string): CredMessages =>
	locale.startsWith("pt") ? ptBR : locale.startsWith("es") ? es : en;
