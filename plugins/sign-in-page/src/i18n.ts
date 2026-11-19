/**
 * Sign-in page plugin copy, one typed catalog per locale — same
 * contract as plugins/auth/src/i18n.ts and plugins/verify-email:
 * plugins cannot import the host's message catalogs, so the pages
 * resolve strings here from the active locale (PageContext.locale /
 * PageI18nSlice.locale). Strings mirror the host's `app.login_*`,
 * `app.portal_login_*` and `app.nav_*_login` keys
 * (apps/web/messages/*.json) so the migration is copy-identical; a
 * locale catalog must implement `SignInMessages` in full — a missing
 * key is a type error, not an English fallback at runtime.
 */

export const SIGN_IN_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). The
 * plugin ids (`sign-in-page.pages`) strip their last segment to the
 * same namespace — see packages/app-host/src/namespaces.ts. */
export const I18N_NAMESPACE = "sign-in-page";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): SignInMessages => signInMessages(locale);
export type SignInLocale = (typeof SIGN_IN_LOCALES)[number];

export interface SignInMessages {
	/** /login picker — document title (page `head` hook). */
	readonly pickerMetaTitle: string;
	/** /login picker card heading. */
	readonly pickerHeading: string;
	/** /login picker card description. */
	readonly pickerDesc: string;
	/** /login/patient — document title (page `head` hook). */
	readonly patientMetaTitle: string;
	/** Patient sign-in heading (sign-in tab). */
	readonly patientHeadingIn: string;
	/** Patient sign-up heading (create-account tab). */
	readonly patientHeadingUp: string;
	/** Patient sign-in description. */
	readonly patientDescIn: string;
	/** Patient sign-up description. */
	readonly patientDescUp: string;
	/** Sign-in / create-account tab labels. */
	readonly tabIn: string;
	readonly tabUp: string;
	/** Sign-up-only fields. */
	readonly name: string;
	readonly confirmPassword: string;
	/** Shared credential fields. */
	readonly email: string;
	readonly password: string;
	readonly forgotPassword: string;
	/** Errors and pending/submit labels. */
	readonly errorPasswordMismatch: string;
	readonly errorFallback: string;
	readonly pending: string;
	readonly submitIn: string;
	readonly submitUp: string;
	/** "I am a doctor" cross-link under the patient form — rendered only
	 * while the doctor sign-in tile is live. */
	readonly doctorLink: string;
}

const en: SignInMessages = {
	pickerMetaTitle: "Sign in | KTB Health",
	pickerHeading: "Sign in",
	pickerDesc: "Choose your role to continue.",
	patientMetaTitle: "Patient sign in | KTB Health",
	patientHeadingIn: "Patient portal",
	patientHeadingUp: "Create patient account",
	patientDescIn: "Sign in to see your consultations.",
	patientDescUp: "Create an account to see the consultations your doctors recorded for you.",
	tabIn: "Sign in",
	tabUp: "Create account",
	name: "Full name",
	confirmPassword: "Confirm password",
	email: "Email",
	password: "Password",
	forgotPassword: "Forgot your password?",
	errorPasswordMismatch: "Passwords do not match.",
	errorFallback: "Could not sign in. Please try again.",
	pending: "Please wait…",
	submitIn: "Sign in",
	submitUp: "Create account",
	doctorLink: "I am a doctor",
};

const ptBR: SignInMessages = {
	pickerMetaTitle: "Entrar | KTB Health",
	pickerHeading: "Entrar",
	pickerDesc: "Escolha o seu perfil para continuar.",
	patientMetaTitle: "Entrar como paciente | KTB Health",
	patientHeadingIn: "Portal do paciente",
	patientHeadingUp: "Criar conta de paciente",
	patientDescIn: "Entre para ver suas consultas.",
	patientDescUp: "Crie uma conta para ver as consultas que seus médicos registraram para você.",
	tabIn: "Entrar",
	tabUp: "Criar conta",
	name: "Nome completo",
	confirmPassword: "Confirmar senha",
	email: "E-mail",
	password: "Senha",
	forgotPassword: "Esqueci minha senha",
	errorPasswordMismatch: "As senhas não coincidem.",
	errorFallback: "Não foi possível entrar. Tente novamente.",
	pending: "Aguarde…",
	submitIn: "Entrar",
	submitUp: "Criar conta",
	doctorLink: "Sou médico",
};

const es: SignInMessages = {
	pickerMetaTitle: "Iniciar sesión | KTB Health",
	pickerHeading: "Iniciar sesión",
	pickerDesc: "Elige tu perfil para continuar.",
	patientMetaTitle: "Entrar como paciente | KTB Health",
	patientHeadingIn: "Portal del paciente",
	patientHeadingUp: "Crear cuenta de paciente",
	patientDescIn: "Inicia sesión para ver tus consultas.",
	patientDescUp: "Crea una cuenta para ver las consultas que tus médicos registraron para ti.",
	tabIn: "Iniciar sesión",
	tabUp: "Crear cuenta",
	name: "Nombre completo",
	confirmPassword: "Confirmar contraseña",
	email: "Correo electrónico",
	password: "Contraseña",
	forgotPassword: "Olvidé mi contraseña",
	errorPasswordMismatch: "Las contraseñas no coinciden.",
	errorFallback: "No se pudo iniciar sesión. Inténtelo de nuevo.",
	pending: "Espere…",
	submitIn: "Iniciar sesión",
	submitUp: "Crear cuenta",
	doctorLink: "Soy médico",
};

const BASE_LOCALE: SignInLocale = "en";

const CATALOGS: Record<SignInLocale, SignInMessages> = { en, "pt-BR": ptBR, es };

export const isSignInLocale = (locale: string): locale is SignInLocale =>
	(SIGN_IN_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const signInMessages = (locale: string): SignInMessages =>
	CATALOGS[isSignInLocale(locale) ? locale : BASE_LOCALE];
