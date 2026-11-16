/**
 * Users plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the panel page ctx and the view resolves its
 * strings here. A locale catalog must implement `UserMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

import { paramMessage } from "@ktb/i18n";

export const USER_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "users";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): UserMessages => userMessages(locale);
export type UserLocale = (typeof USER_LOCALES)[number];
export const BASE_LOCALE: UserLocale = "en";

export interface UserMessages {
	readonly title: string;
	readonly none: string;
	readonly count: (n: number) => string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly colId: string;
	readonly colName: string;
	readonly colEmail: string;
	readonly colVerified: string;
	readonly colPatients: string;
	readonly colConsultations: string;
	readonly colRole: string;
	readonly colStatus: string;
	readonly colCreated: string;
	readonly colActions: string;
	readonly yes: string;
	readonly no: string;
	readonly roleAdmin: string;
	readonly roleUser: string;
	readonly statusActive: string;
	readonly statusSuspended: string;
	readonly suspend: string;
	readonly reactivate: string;
	readonly suspendTitle: string;
	readonly suspendDescription: (email: string) => string;
	readonly suspendConfirm: string;
	readonly cancel: string;
	readonly saveError: string;
	readonly searchPlaceholder: string;
	readonly searchLabel: string;
	readonly noMatch: string;
	readonly filteredCount: (shown: number, total: number) => string;
}

const en: UserMessages = {
	title: "Users",
	none: "No users registered.",
	count: paramMessage("en", "{n, plural, =1{{n} user} other{{n} users}} across the platform.", [
		"n",
	]),
	emptyTitle: "No users",
	emptyDescription: "Users appear here once they sign up.",
	colId: "Id",
	colName: "Name",
	colEmail: "Email",
	colVerified: "Verified",
	colPatients: "Patients",
	colConsultations: "Consultations",
	colRole: "Role",
	colStatus: "Status",
	colCreated: "Created",
	colActions: "Actions",
	yes: "yes",
	no: "no",
	roleAdmin: "admin",
	roleUser: "user",
	statusActive: "active",
	statusSuspended: "suspended",
	suspend: "Suspend",
	reactivate: "Reactivate",
	suspendTitle: "Suspend user",
	suspendDescription: paramMessage(
		"en",
		"Suspend {email}? They will be signed out and unable to sign in until reactivated.",
		["email"],
	),
	suspendConfirm: "Suspend",
	cancel: "Cancel",
	saveError: "Could not update the user. Try again.",
	searchPlaceholder: "Search by name or email…",
	searchLabel: "Search users",
	noMatch: "No users match the search.",
	filteredCount: paramMessage("en", "Showing {shown} of {total}", ["shown", "total"]),
};

const ptBR: UserMessages = {
	title: "Usuários",
	none: "Nenhum usuário cadastrado.",
	count: paramMessage(
		"pt-BR",
		"{n, plural, =1{{n} usuário} other{{n} usuários}} em toda a plataforma.",
		["n"],
	),
	emptyTitle: "Nenhum usuário",
	emptyDescription: "Os usuários aparecem aqui após se cadastrarem.",
	colId: "Id",
	colName: "Nome",
	colEmail: "E-mail",
	colVerified: "Verificado",
	colPatients: "Pacientes",
	colConsultations: "Consultas",
	colRole: "Papel",
	colStatus: "Status",
	colCreated: "Criado em",
	colActions: "Ações",
	yes: "sim",
	no: "não",
	roleAdmin: "admin",
	roleUser: "usuário",
	statusActive: "ativo",
	statusSuspended: "suspenso",
	suspend: "Suspender",
	reactivate: "Reativar",
	suspendTitle: "Suspender usuário",
	suspendDescription: paramMessage(
		"pt-BR",
		"Suspender {email}? O usuário será desconectado e não poderá entrar até ser reativado.",
		["email"],
	),
	suspendConfirm: "Suspender",
	cancel: "Cancelar",
	saveError: "Não foi possível atualizar o usuário. Tente novamente.",
	searchPlaceholder: "Buscar por nome ou e-mail…",
	searchLabel: "Buscar usuários",
	noMatch: "Nenhum usuário corresponde à busca.",
	filteredCount: paramMessage("pt-BR", "Exibindo {shown} de {total}", ["shown", "total"]),
};

const es: UserMessages = {
	title: "Usuarios",
	none: "Ningún usuario registrado.",
	count: paramMessage(
		"es",
		"{n, plural, =1{{n} usuario} other{{n} usuarios}} en toda la plataforma.",
		["n"],
	),
	emptyTitle: "Ningún usuario",
	emptyDescription: "Los usuarios aparecen aquí una vez que se registran.",
	colId: "Id",
	colName: "Nombre",
	colEmail: "Correo electrónico",
	colVerified: "Verificado",
	colPatients: "Pacientes",
	colConsultations: "Consultas",
	colRole: "Rol",
	colStatus: "Estado",
	colCreated: "Creado",
	colActions: "Acciones",
	yes: "sí",
	no: "no",
	roleAdmin: "admin",
	roleUser: "usuario",
	statusActive: "activo",
	statusSuspended: "suspendido",
	suspend: "Suspender",
	reactivate: "Reactivar",
	suspendTitle: "Suspender usuario",
	suspendDescription: paramMessage(
		"es",
		"¿Suspender a {email}? Se cerrará su sesión y no podrá iniciar sesión hasta que se reactive.",
		["email"],
	),
	suspendConfirm: "Suspender",
	cancel: "Cancelar",
	saveError: "No se pudo actualizar el usuario. Inténtalo de nuevo.",
	searchPlaceholder: "Buscar por nombre o correo…",
	searchLabel: "Buscar usuarios",
	noMatch: "Ningún usuario coincide con la búsqueda.",
	filteredCount: paramMessage("es", "Mostrando {shown} de {total}", ["shown", "total"]),
};

const CATALOGS: Record<UserLocale, UserMessages> = { en, "pt-BR": ptBR, es };

export const isUserLocale = (locale: string): locale is UserLocale =>
	(USER_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const userMessages = (locale: string): UserMessages =>
	CATALOGS[isUserLocale(locale) ? locale : BASE_LOCALE];
