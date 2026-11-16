/**
 * Invites plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint), so the host passes the
 * active locale in and every view resolves its strings here. A locale
 * catalog must implement `InviteMessages` in full — a missing key is a
 * type error, not an English fallback at runtime.
 */
import { paramMessage } from "@ktb/i18n";
import type { InviteKind } from "./schema.ts";

/** Locales with a catalog; the host asserts it covers every app locale. */
export const INVITE_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "invites";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): InviteMessages => inviteMessages(locale);
export type InviteLocale = (typeof INVITE_LOCALES)[number];
export const BASE_LOCALE: InviteLocale = "en";

/** Why accepting failed, as the view tells it: the wire codes plus
 * "failed" for a request that did not complete. */
export type InviteFailure =
	| "invalid"
	| "account_exists"
	| "invalid_name"
	| "invalid_password"
	| "failed";

export interface InviteMessages {
	readonly metaTitle: string;
	/** Heading of the accept form, per invite kind. */
	readonly heading: Record<InviteKind, (inviter: string) => string>;
	readonly description: string;
	readonly email: string;
	readonly name: string;
	readonly password: string;
	readonly confirmPassword: string;
	readonly submit: string;
	readonly pending: string;
	readonly errorPasswordMismatch: string;
	readonly errors: Record<InviteFailure, string>;
	/** The account exists but signing in right after did not work. */
	readonly createdTitle: string;
	readonly createdSignIn: string;
	readonly existsTitle: string;
	readonly existsBody: (email: string) => string;
	readonly invalidTitle: string;
	readonly invalidBody: string;
	readonly signIn: string;
}

const en: InviteMessages = {
	metaTitle: "Accept invitation | KTB Health",
	heading: {
		secretary: paramMessage("en", "{inviter} invited you to work on their behalf", ["inviter"]),
		patient: paramMessage("en", "{inviter} gave you access to the patient portal", ["inviter"]),
	},
	description:
		"Choose a password to create your account. This invitation already confirms your email address.",
	email: "Email",
	name: "Full name",
	password: "Password",
	confirmPassword: "Confirm password",
	submit: "Create account and continue",
	pending: "Please wait…",
	errorPasswordMismatch: "Passwords do not match.",
	errors: {
		invalid: "This invitation is no longer valid. Ask for a new one.",
		account_exists: "This email address already has an account. Sign in instead.",
		invalid_name: "Enter your name.",
		invalid_password: "Choose a password with 8 to 128 characters.",
		failed: "Could not accept the invitation. Please try again.",
	},
	createdTitle: "Account created",
	createdSignIn: "Your account was created. Sign in to continue.",
	existsTitle: "You already have an account",
	existsBody: paramMessage(
		"en",
		"{email} already has a KTB Health account. Sign in with it to see what you were invited to.",
		["email"],
	),
	invalidTitle: "This invitation is no longer valid",
	invalidBody:
		"The link was already used or has expired. Ask whoever invited you to send a new invitation, or sign in if you already have an account.",
	signIn: "Sign in",
};

const ptBR: InviteMessages = {
	metaTitle: "Aceitar convite | KTB Health",
	heading: {
		secretary: paramMessage("pt-BR", "{inviter} convidou você para trabalhar em nome dele(a)", [
			"inviter",
		]),
		patient: paramMessage("pt-BR", "{inviter} liberou seu acesso ao portal do paciente", [
			"inviter",
		]),
	},
	description:
		"Escolha uma senha para criar sua conta. Este convite já confirma seu endereço de e-mail.",
	email: "E-mail",
	name: "Nome completo",
	password: "Senha",
	confirmPassword: "Confirmar senha",
	submit: "Criar conta e continuar",
	pending: "Aguarde…",
	errorPasswordMismatch: "As senhas não coincidem.",
	errors: {
		invalid: "Este convite não é mais válido. Peça um novo.",
		account_exists: "Este e-mail já tem uma conta. Entre com ela.",
		invalid_name: "Informe seu nome.",
		invalid_password: "Escolha uma senha com 8 a 128 caracteres.",
		failed: "Não foi possível aceitar o convite. Tente novamente.",
	},
	createdTitle: "Conta criada",
	createdSignIn: "Sua conta foi criada. Entre para continuar.",
	existsTitle: "Você já tem uma conta",
	existsBody: paramMessage(
		"pt-BR",
		"{email} já tem uma conta no KTB Health. Entre com ela para ver o que foi liberado para você.",
		["email"],
	),
	invalidTitle: "Este convite não é mais válido",
	invalidBody:
		"O link já foi usado ou expirou. Peça a quem convidou você que envie um novo convite, ou entre se já tiver uma conta.",
	signIn: "Entrar",
};

const es: InviteMessages = {
	metaTitle: "Aceptar invitación | KTB Health",
	heading: {
		secretary: paramMessage("es", "{inviter} te invitó a trabajar en su nombre", ["inviter"]),
		patient: paramMessage("es", "{inviter} te dio acceso al portal del paciente", ["inviter"]),
	},
	description:
		"Elige una contraseña para crear tu cuenta. Esta invitación ya confirma tu dirección de correo.",
	email: "Correo",
	name: "Nombre completo",
	password: "Contraseña",
	confirmPassword: "Confirmar contraseña",
	submit: "Crear cuenta y continuar",
	pending: "Espere…",
	errorPasswordMismatch: "Las contraseñas no coinciden.",
	errors: {
		invalid: "Esta invitación ya no es válida. Pide una nueva.",
		account_exists: "Este correo ya tiene una cuenta. Inicia sesión con ella.",
		invalid_name: "Ingresa tu nombre.",
		invalid_password: "Elige una contraseña de 8 a 128 caracteres.",
		failed: "No se pudo aceptar la invitación. Inténtalo de nuevo.",
	},
	createdTitle: "Cuenta creada",
	createdSignIn: "Tu cuenta fue creada. Inicia sesión para continuar.",
	existsTitle: "Ya tienes una cuenta",
	existsBody: paramMessage(
		"es",
		"{email} ya tiene una cuenta en KTB Health. Inicia sesión con ella para ver a qué te invitaron.",
		["email"],
	),
	invalidTitle: "Esta invitación ya no es válida",
	invalidBody:
		"El enlace ya fue usado o venció. Pide a quien te invitó que envíe una nueva invitación, o inicia sesión si ya tienes una cuenta.",
	signIn: "Iniciar sesión",
};

const CATALOGS: Record<InviteLocale, InviteMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isInviteLocale = (locale: string): locale is InviteLocale =>
	(INVITE_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const inviteMessages = (locale: string): InviteMessages =>
	CATALOGS[isInviteLocale(locale) ? locale : BASE_LOCALE];
