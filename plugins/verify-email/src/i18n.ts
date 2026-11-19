import { paramMessage } from "@ktb/i18n";

/**
 * Verify-email plugin copy, one typed catalog per locale — same
 * contract as plugins/auth/src/i18n.ts: plugins cannot import the
 * host's message catalogs, so the page resolves strings here from the
 * active locale (PageContext.locale / PageI18nSlice.locale). Strings
 * mirror the host's `app.verify_*` keys (apps/web/messages/*.json) so
 * the migration is copy-identical; a locale catalog must implement
 * `VerifyEmailMessages` in full — a missing key is a type error, not
 * an English fallback at runtime.
 */

export const VERIFY_EMAIL_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "verify-email";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): VerifyEmailMessages => verifyEmailMessages(locale);
export type VerifyEmailLocale = (typeof VERIFY_EMAIL_LOCALES)[number];

export interface VerifyEmailMessages {
	/** Document title — resolved by the page `head` hook. */
	readonly metaTitle: string;
	/** Resend card heading. */
	readonly heading: string;
	/** Signed-in description — param is the account email. */
	readonly descSigned: (email: string) => string;
	/** Anonymous description. */
	readonly descAnon: string;
	/** Deployments with no outbound email swap the form for this. */
	readonly unavailable: string;
	/** Verified-state card. */
	readonly doneHeading: string;
	/** Verified-state description — param is the account email. */
	readonly doneDesc: (email: string) => string;
	readonly continueLabel: string;
	readonly emailLabel: string;
	readonly pending: string;
	readonly submit: string;
	/** Neutral confirmation — identical whether or not the address has
	 * an account awaiting verification. */
	readonly sent: string;
	readonly errorFallback: string;
}

const en: VerifyEmailMessages = {
	metaTitle: "Verify email | KTB Health",
	heading: "Verify your email",
	descSigned: paramMessage(
		"en",
		"We sent a verification link to {email}. Open it to confirm your address.",
		["email"],
	),
	descAnon: "Enter your account email and we will send a new verification link.",
	unavailable: "Email verification is not available on this deployment.",
	doneHeading: "Email verified",
	doneDesc: paramMessage("en", "Your address {email} is confirmed.", ["email"]),
	continueLabel: "Continue",
	emailLabel: "Email",
	pending: "Please wait…",
	submit: "Resend verification link",
	sent: "If this address has an account awaiting verification, a new link is on its way.",
	errorFallback: "Could not send the link. Please try again.",
};

const ptBR: VerifyEmailMessages = {
	metaTitle: "Verificar e-mail | KTB Health",
	heading: "Verifique seu e-mail",
	descSigned: paramMessage(
		"pt-BR",
		"Enviamos um link de verificação para {email}. Abra-o para confirmar seu endereço.",
		["email"],
	),
	descAnon: "Informe o e-mail da sua conta e enviaremos um novo link de verificação.",
	unavailable: "A verificação de e-mail não está disponível nesta instalação.",
	doneHeading: "E-mail verificado",
	doneDesc: paramMessage("pt-BR", "Seu endereço {email} está confirmado.", ["email"]),
	continueLabel: "Continuar",
	emailLabel: "E-mail",
	pending: "Aguarde…",
	submit: "Reenviar link de verificação",
	sent: "Se este endereço tiver uma conta aguardando verificação, um novo link está a caminho.",
	errorFallback: "Não foi possível enviar o link. Tente novamente.",
};

const es: VerifyEmailMessages = {
	metaTitle: "Verificar correo | KTB Health",
	heading: "Verifica tu correo",
	descSigned: paramMessage(
		"es",
		"Enviamos un enlace de verificación a {email}. Ábrelo para confirmar tu dirección.",
		["email"],
	),
	descAnon: "Ingresa el correo de tu cuenta y te enviaremos un nuevo enlace de verificación.",
	unavailable: "La verificación de correo no está disponible en este despliegue.",
	doneHeading: "Correo verificado",
	doneDesc: paramMessage("es", "Tu dirección {email} está confirmada.", ["email"]),
	continueLabel: "Continuar",
	emailLabel: "Correo electrónico",
	pending: "Espere…",
	submit: "Reenviar enlace de verificación",
	sent: "Si esta dirección tiene una cuenta pendiente de verificación, un nuevo enlace está en camino.",
	errorFallback: "No se pudo enviar el enlace. Inténtalo de nuevo.",
};

const CATALOGS: Record<VerifyEmailLocale, VerifyEmailMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

/** Resolve the messages catalog for `locale`; unknown locales fall
 * back to the base locale (en). */
export const verifyEmailMessages = (locale: string): VerifyEmailMessages =>
	CATALOGS[locale as VerifyEmailLocale] ?? en;
