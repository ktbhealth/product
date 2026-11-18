/**
 * Auth plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint), so the login route
 * loader attaches the active locale (localeFn → getLocale) and the
 * view resolves its strings here. A locale catalog must implement
 * `AuthMessages` in full — a missing key is a type error, not an
 * English fallback at runtime.
 */

export const AUTH_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "auth";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): AuthMessages => authMessages(locale);
export type AuthLocale = (typeof AUTH_LOCALES)[number];
export const BASE_LOCALE: AuthLocale = "en";

export interface AuthMessages {
	readonly metaTitle: string;
	readonly headingIn: string;
	readonly headingUp: string;
	readonly descIn: string;
	readonly descUp: string;
	readonly tabIn: string;
	readonly tabUp: string;
	readonly email: string;
	readonly password: string;
	readonly confirmPassword: string;
	readonly showPassword: string;
	readonly hidePassword: string;
	readonly submitIn: string;
	readonly submitUp: string;
	readonly pending: string;
	readonly errorFallback: string;
	readonly errorPasswordMismatch: string;
	readonly verifyLink: string;
	readonly secretaryLink: string;
	readonly forgotLink: string;
	/** /forgot-password — asks for the account email and mails a
	 * single-use reset link. */
	readonly forgotMetaTitle: string;
	readonly forgotHeading: string;
	readonly forgotDesc: string;
	readonly forgotSubmit: string;
	/** Neutral confirmation — identical whether or not the address has
	 * an account, so the page never reveals registrations. */
	readonly forgotSent: string;
	/** Shown instead of the form when the deployment cannot send email. */
	readonly forgotUnavailable: string;
	/** /reset-password — the emailed link lands here with `?token=`. */
	readonly resetMetaTitle: string;
	readonly resetHeading: string;
	readonly resetDesc: string;
	readonly newPassword: string;
	readonly resetSubmit: string;
	readonly resetDoneHeading: string;
	readonly resetDoneDesc: string;
	/** Invalid/expired/absent token — offers a fresh reset request. */
	readonly resetInvalidHeading: string;
	readonly resetInvalidDesc: string;
	readonly resetRequestNew: string;
	readonly resetError: string;
	readonly backToSignIn: string;
	readonly adminLink: string;
	readonly metaTitleAdmin: string;
	readonly headingAdmin: string;
	readonly descAdmin: string;
	readonly submitAdmin: string;
	readonly errorDenied: string;
	readonly signInLink: string;
}

const en: AuthMessages = {
	metaTitle: "Sign in | KTB Health",
	headingIn: "Sign in",
	headingUp: "Create account",
	descIn: "Sign in to your account to continue.",
	descUp: "Create an account to get started.",
	tabIn: "Sign in",
	tabUp: "Create account",
	email: "Email",
	password: "Password",
	confirmPassword: "Confirm password",
	showPassword: "Show password",
	hidePassword: "Hide password",
	submitIn: "Sign in",
	submitUp: "Create account",
	pending: "Please wait…",
	errorFallback: "Could not sign in. Please try again.",
	errorPasswordMismatch: "Passwords do not match.",
	verifyLink: "Didn't get the verification email?",
	secretaryLink: "I am a secretary",
	forgotLink: "Forgot your password?",
	forgotMetaTitle: "Reset password | KTB Health",
	forgotHeading: "Reset your password",
	forgotDesc: "Enter your account email and we will send you a reset link.",
	forgotSubmit: "Send reset link",
	forgotSent: "If this address has an account, a reset link is on its way.",
	forgotUnavailable: "Password reset is not available on this deployment.",
	resetMetaTitle: "Choose a new password | KTB Health",
	resetHeading: "Choose a new password",
	resetDesc: "Enter and confirm your new password.",
	newPassword: "New password",
	resetSubmit: "Update password",
	resetDoneHeading: "Password updated",
	resetDoneDesc: "Sign in with your new password to continue.",
	resetInvalidHeading: "Invalid reset link",
	resetInvalidDesc: "This password reset link is invalid or has expired. Request a new one.",
	resetRequestNew: "Request a new link",
	resetError: "Could not update the password. The link may have expired — request a new one.",
	backToSignIn: "Back to sign in",
	adminLink: "Administrator sign in",
	metaTitleAdmin: "Admin sign in | KTB Health",
	headingAdmin: "Administrator sign in",
	descAdmin: "Sign in with an account that has platform admin access.",
	submitAdmin: "Sign in",
	errorDenied: "This account does not have administrator access.",
	signInLink: "Back to sign in",
};

const ptBR: AuthMessages = {
	metaTitle: "Entrar | KTB Health",
	headingIn: "Entrar",
	headingUp: "Criar conta",
	descIn: "Entre na sua conta para continuar.",
	descUp: "Crie uma conta para começar.",
	tabIn: "Entrar",
	tabUp: "Criar conta",
	email: "E-mail",
	password: "Senha",
	confirmPassword: "Confirmar senha",
	showPassword: "Mostrar senha",
	hidePassword: "Ocultar senha",
	submitIn: "Entrar",
	submitUp: "Criar conta",
	pending: "Aguarde…",
	errorFallback: "Não foi possível entrar. Tente novamente.",
	errorPasswordMismatch: "As senhas não coincidem.",
	verifyLink: "Não recebeu o e-mail de verificação?",
	secretaryLink: "Sou secretária",
	forgotLink: "Esqueci minha senha",
	forgotMetaTitle: "Redefinir senha | KTB Health",
	forgotHeading: "Redefina sua senha",
	forgotDesc: "Informe o e-mail da sua conta e enviaremos um link para redefinir a senha.",
	forgotSubmit: "Enviar link de redefinição",
	forgotSent: "Se este endereço tiver uma conta, um link de redefinição está a caminho.",
	forgotUnavailable: "A redefinição de senha não está disponível nesta instalação.",
	resetMetaTitle: "Escolha uma nova senha | KTB Health",
	resetHeading: "Escolha uma nova senha",
	resetDesc: "Digite e confirme sua nova senha.",
	newPassword: "Nova senha",
	resetSubmit: "Atualizar senha",
	resetDoneHeading: "Senha atualizada",
	resetDoneDesc: "Entre com sua nova senha para continuar.",
	resetInvalidHeading: "Link inválido",
	resetInvalidDesc: "Este link de redefinição é inválido ou expirou. Peça um novo.",
	resetRequestNew: "Pedir novo link",
	resetError: "Não foi possível atualizar a senha. O link pode ter expirado — peça um novo.",
	backToSignIn: "Voltar para entrar",
	adminLink: "Acesso administrativo",
	metaTitleAdmin: "Acesso admin | KTB Health",
	headingAdmin: "Acesso administrativo",
	descAdmin: "Entre com uma conta que tenha acesso de administrador à plataforma.",
	submitAdmin: "Entrar",
	errorDenied: "Esta conta não tem acesso de administrador.",
	signInLink: "Voltar para o login",
};

const es: AuthMessages = {
	metaTitle: "Iniciar sesión | KTB Health",
	headingIn: "Iniciar sesión",
	headingUp: "Crear cuenta",
	descIn: "Inicie sesión en su cuenta para continuar.",
	descUp: "Cree una cuenta para comenzar.",
	tabIn: "Iniciar sesión",
	tabUp: "Crear cuenta",
	email: "Correo electrónico",
	password: "Contraseña",
	confirmPassword: "Confirmar contraseña",
	showPassword: "Mostrar contraseña",
	hidePassword: "Ocultar contraseña",
	submitIn: "Iniciar sesión",
	submitUp: "Crear cuenta",
	pending: "Espere…",
	errorFallback: "No se pudo iniciar sesión. Inténtelo de nuevo.",
	errorPasswordMismatch: "Las contraseñas no coinciden.",
	verifyLink: "¿No recibiste el correo de verificación?",
	secretaryLink: "Soy secretaria",
	forgotLink: "Olvidé mi contraseña",
	forgotMetaTitle: "Restablecer contraseña | KTB Health",
	forgotHeading: "Restablece tu contraseña",
	forgotDesc: "Ingresa el correo de tu cuenta y te enviaremos un enlace para restablecerla.",
	forgotSubmit: "Enviar enlace",
	forgotSent: "Si esta dirección tiene una cuenta, un enlace de restablecimiento está en camino.",
	forgotUnavailable: "El restablecimiento de contraseña no está disponible en este despliegue.",
	resetMetaTitle: "Elige una nueva contraseña | KTB Health",
	resetHeading: "Elige una nueva contraseña",
	resetDesc: "Ingresa y confirma tu nueva contraseña.",
	newPassword: "Nueva contraseña",
	resetSubmit: "Actualizar contraseña",
	resetDoneHeading: "Contraseña actualizada",
	resetDoneDesc: "Inicia sesión con tu nueva contraseña para continuar.",
	resetInvalidHeading: "Enlace inválido",
	resetInvalidDesc: "Este enlace de restablecimiento es inválido o expiró. Solicita uno nuevo.",
	resetRequestNew: "Solicitar un nuevo enlace",
	resetError:
		"No se pudo actualizar la contraseña. El enlace pudo haber expirado — solicita uno nuevo.",
	backToSignIn: "Volver a iniciar sesión",
	adminLink: "Acceso de administrador",
	metaTitleAdmin: "Acceso admin | KTB Health",
	headingAdmin: "Acceso de administrador",
	descAdmin: "Inicie sesión con una cuenta con acceso de administrador a la plataforma.",
	submitAdmin: "Iniciar sesión",
	errorDenied: "Esta cuenta no tiene acceso de administrador.",
	signInLink: "Volver al inicio de sesión",
};

const CATALOGS: Record<AuthLocale, AuthMessages> = { en, "pt-BR": ptBR, es };

export const isAuthLocale = (locale: string): locale is AuthLocale =>
	(AUTH_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const authMessages = (locale: string): AuthMessages =>
	CATALOGS[isAuthLocale(locale) ? locale : BASE_LOCALE];
