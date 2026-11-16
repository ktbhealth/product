/**
 * Audit plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale through the panel page ctx and the view resolves its
 * strings here. A locale catalog must implement `AuditMessages` in
 * full — a missing key is a type error, not an English fallback.
 */

export const AUDIT_LOCALES = ["en", "pt-BR", "es"] as const;
export type AuditLocale = (typeof AUDIT_LOCALES)[number];
export const BASE_LOCALE: AuditLocale = "en";

export interface AuditMessages {
	readonly title: string;
	/** Staff-feed heading (P-080) — the portal page reuses this view
	 * with its own title instead of the console's "Audit log". */
	readonly activityTitle: string;
	readonly description: (shown: number, total: number) => string;
	readonly searchPlaceholder: string;
	readonly searchLabel: string;
	readonly allActions: string;
	readonly allActors: string;
	readonly allTargetTypes: string;
	/** Filter-option label for rows with no target type (null column). */
	readonly noTargetType: string;
	readonly noMatch: string;
	readonly filteredCount: (shown: number, total: number) => string;
	readonly colTime: string;
	readonly colActor: string;
	readonly colAction: string;
	readonly colTarget: string;
	readonly colTenant: string;
	readonly colDetail: string;
	readonly emptyTitle: string;
	readonly emptyDescription: string;
	readonly detailTitle: string;
	readonly systemActor: string;
	readonly noTarget: string;
	readonly noTenant: string;
	/** On-demand chain verification (platform console only). */
	readonly verifyButton: string;
	readonly verifyRunning: string;
	readonly verifyVerified: (entries: number) => string;
	readonly verifyTampered: (brokenAt: number | null) => string;
	readonly verifyEmpty: string;
	readonly verifyFailed: string;
}

const en: AuditMessages = {
	title: "Audit log",
	activityTitle: "Activity",
	description: (shown, total) =>
		shown >= total
			? `${total} admin ${total === 1 ? "action" : "actions"} recorded.`
			: `Latest ${shown} of ${total} admin ${total === 1 ? "action" : "actions"}.`,
	searchPlaceholder: "Search actor, action or target…",
	searchLabel: "Search audit entries",
	allActions: "All actions",
	allActors: "All actors",
	allTargetTypes: "All target types",
	noTargetType: "none",
	noMatch: "No entries match the filters.",
	filteredCount: (shown, total) => `Showing ${shown} of ${total}`,
	colTime: "Time",
	colActor: "Actor",
	colAction: "Action",
	colTarget: "Target",
	colTenant: "Tenant",
	colDetail: "Detail",
	emptyTitle: "No audit entries",
	emptyDescription: "Platform admin actions will appear here.",
	detailTitle: "Audit entry",
	systemActor: "system",
	noTarget: "—",
	noTenant: "—",
	verifyButton: "Verify chain",
	verifyRunning: "Verifying…",
	verifyVerified: (entries) =>
		`Chain verified — ${entries} ${entries === 1 ? "entry" : "entries"} intact.`,
	verifyTampered: (brokenAt) => `Chain tampered — first broken link at entry #${brokenAt ?? "?"}.`,
	verifyEmpty: "The audit log is empty — nothing to verify.",
	verifyFailed: "Verification failed — the request was denied or errored.",
};

const ptBR: AuditMessages = {
	title: "Log de auditoria",
	activityTitle: "Atividade",
	description: (shown, total) =>
		shown >= total
			? `${total} ${total === 1 ? "ação" : "ações"} de admin registradas.`
			: `Últimas ${shown} de ${total} ${total === 1 ? "ação" : "ações"} de admin.`,
	searchPlaceholder: "Buscar ator, ação ou alvo…",
	searchLabel: "Buscar entradas de auditoria",
	allActions: "Todas as ações",
	allActors: "Todos os atores",
	allTargetTypes: "Todos os tipos de alvo",
	noTargetType: "nenhum",
	noMatch: "Nenhuma entrada corresponde aos filtros.",
	filteredCount: (shown, total) => `Exibindo ${shown} de ${total}`,
	colTime: "Hora",
	colActor: "Ator",
	colAction: "Ação",
	colTarget: "Alvo",
	colTenant: "Tenant",
	colDetail: "Detalhe",
	emptyTitle: "Nenhuma entrada de auditoria",
	emptyDescription: "As ações de admin da plataforma aparecerão aqui.",
	detailTitle: "Entrada de auditoria",
	systemActor: "sistema",
	noTarget: "—",
	noTenant: "—",
	verifyButton: "Verificar cadeia",
	verifyRunning: "Verificando…",
	verifyVerified: (entries) =>
		`Cadeia verificada — ${entries} ${entries === 1 ? "entrada" : "entradas"} íntegras.`,
	verifyTampered: (brokenAt) =>
		`Cadeia adulterada — primeiro elo quebrado na entrada #${brokenAt ?? "?"}.`,
	verifyEmpty: "O log de auditoria está vazio — nada a verificar.",
	verifyFailed: "A verificação falhou — a solicitação foi negada ou erro.",
};

const es: AuditMessages = {
	title: "Registro de auditoría",
	activityTitle: "Actividad",
	description: (shown, total) =>
		shown >= total
			? `${total} ${total === 1 ? "acción" : "acciones"} de admin registradas.`
			: `Últimas ${shown} de ${total} ${total === 1 ? "acción" : "acciones"} de admin.`,
	searchPlaceholder: "Buscar actor, acción o destino…",
	searchLabel: "Buscar entradas de auditoría",
	allActions: "Todas las acciones",
	allActors: "Todos los actores",
	allTargetTypes: "Todos los tipos de destino",
	noTargetType: "ninguno",
	noMatch: "Ninguna entrada coincide con los filtros.",
	filteredCount: (shown, total) => `Mostrando ${shown} de ${total}`,
	colTime: "Hora",
	colActor: "Actor",
	colAction: "Acción",
	colTarget: "Destino",
	colTenant: "Tenant",
	colDetail: "Detalle",
	emptyTitle: "Sin entradas de auditoría",
	emptyDescription: "Las acciones de admin de la plataforma aparecerán aquí.",
	detailTitle: "Entrada de auditoría",
	systemActor: "sistema",
	noTarget: "—",
	noTenant: "—",
	verifyButton: "Verificar cadena",
	verifyRunning: "Verificando…",
	verifyVerified: (entries) =>
		`Cadena verificada — ${entries} ${entries === 1 ? "entrada" : "entradas"} íntegras.`,
	verifyTampered: (brokenAt) =>
		`Cadena alterada — primer eslabón roto en la entrada #${brokenAt ?? "?"}.`,
	verifyEmpty: "El registro de auditoría está vacío — nada que verificar.",
	verifyFailed: "La verificación falló — la solicitud fue denegada o erró.",
};

const CATALOGS: Record<AuditLocale, AuditMessages> = { en, "pt-BR": ptBR, es };

export const isAuditLocale = (locale: string): locale is AuditLocale =>
	(AUDIT_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const auditMessages = (locale: string): AuditMessages =>
	CATALOGS[isAuditLocale(locale) ? locale : BASE_LOCALE];
