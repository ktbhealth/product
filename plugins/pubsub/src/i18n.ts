import { paramMessage } from "@ktb/i18n";

/**
 * Pub/sub plugin copy, one typed catalog per locale. Plugins cannot
 * import the host's Paraglide output (arch lint); the host injects the
 * active locale and the views resolve their strings here. A locale
 * catalog must implement `PubSubMessages` in full — a missing key is a
 * type error, not an English fallback at runtime.
 */
export const PUBSUB_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "pubsub";

/** Locale→merged messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): Record<string, unknown> => ({
	...pubSubMessages(locale),
});

export type PubSubLocale = (typeof PUBSUB_LOCALES)[number];
export const BASE_LOCALE: PubSubLocale = "en";

export interface PubSubMessages {
	readonly title: string;
	readonly description: (n: number) => string;
	readonly topicsTitle: string;
	readonly topicsDescription: string;
	readonly tColTopic: string;
	readonly tColTransport: string;
	readonly tColSubscribers: string;
	readonly tColRecent: string;
	readonly tColLastActivity: string;
	readonly subscribersUnknown: string;
	readonly noRecent: string;
	readonly neverActive: string;
	readonly emptyTopicsTitle: string;
	readonly emptyTopicsDescription: string;
	readonly unavailableTitle: string;
	readonly unavailableDescription: string;
	readonly publishTitle: string;
	readonly publishDescription: string;
	readonly pTopic: string;
	readonly pTopicPlaceholder: string;
	readonly pPayload: string;
	readonly pPayloadHint: string;
	readonly publish: string;
	readonly publishing: string;
	readonly publishOk: string;
	readonly publishUnknown: string;
	readonly publishUnavailable: string;
	readonly publishForbidden: string;
	readonly publishFailed: string;
	readonly invalidJson: string;
}

const en: PubSubMessages = {
	title: "Pub/sub",
	description: paramMessage(
		"en",
		"{n, plural, =1{{n} topic across bound transports.} other{{n} topics across bound transports.}}",
		["n"],
	),
	topicsTitle: "Topics",
	topicsDescription:
		"Every channel the bound pub/sub transports enumerate — the in-process bus and Redis channels when bound.",
	tColTopic: "Topic",
	tColTransport: "Transport",
	tColSubscribers: "Subscribers",
	tColRecent: "Recent",
	tColLastActivity: "Last activity",
	subscribersUnknown: "—",
	noRecent: "No history",
	neverActive: "Never",
	emptyTopicsTitle: "No topics yet",
	emptyTopicsDescription:
		"Topics appear here when a transport first publishes or subscribes to a channel.",
	unavailableTitle: "Signal unavailable",
	unavailableDescription: "This signal cannot be read in the current environment.",
	publishTitle: "Publish",
	publishDescription: "Send a JSON payload to a topic by its console id.",
	pTopic: "Topic",
	pTopicPlaceholder: "memory:cron.fires",
	pPayload: "Payload (JSON)",
	pPayloadHint: "Must be valid JSON — quoted keys and values.",
	publish: "Publish",
	publishing: "Publishing…",
	publishOk: "Message published.",
	publishUnknown: "Unknown topic id — pick one from the Topics tab.",
	publishUnavailable: "Pub/sub transport unavailable in this environment.",
	publishForbidden: "Not permitted.",
	publishFailed: "Publish failed.",
	invalidJson: "Payload is not valid JSON.",
};

const ptBR: PubSubMessages = {
	title: "Pub/sub",
	description: paramMessage(
		"pt-BR",
		"{n, plural, =1{{n} tópico nos transportes vinculados.} other{{n} tópicos nos transportes vinculados.}}",
		["n"],
	),
	topicsTitle: "Tópicos",
	topicsDescription:
		"Todos os canais enumerados pelos transportes pub/sub vinculados — o barramento em processo e canais Redis quando houver.",
	tColTopic: "Tópico",
	tColTransport: "Transporte",
	tColSubscribers: "Assinantes",
	tColRecent: "Recentes",
	tColLastActivity: "Última atividade",
	subscribersUnknown: "—",
	noRecent: "Sem histórico",
	neverActive: "Nunca",
	emptyTopicsTitle: "Nenhum tópico ainda",
	emptyTopicsDescription:
		"Tópicos aparecem aqui quando um transporte publica ou assina um canal pela primeira vez.",
	unavailableTitle: "Sinal indisponível",
	unavailableDescription: "Este sinal não pode ser lido no ambiente atual.",
	publishTitle: "Publicar",
	publishDescription: "Envie um payload JSON a um tópico pelo id do console.",
	pTopic: "Tópico",
	pTopicPlaceholder: "memory:cron.fires",
	pPayload: "Payload (JSON)",
	pPayloadHint: "Deve ser JSON válido — chaves e valores entre aspas.",
	publish: "Publicar",
	publishing: "Publicando…",
	publishOk: "Mensagem publicada.",
	publishUnknown: "Id de tópico desconhecido — escolha um na aba Tópicos.",
	publishUnavailable: "Transporte pub/sub indisponível neste ambiente.",
	publishForbidden: "Não permitido.",
	publishFailed: "A publicação falhou.",
	invalidJson: "O payload não é JSON válido.",
};

const es: PubSubMessages = {
	title: "Pub/sub",
	description: paramMessage(
		"es",
		"{n, plural, =1{{n} tema en los transportes vinculados.} other{{n} temas en los transportes vinculados.}}",
		["n"],
	),
	topicsTitle: "Temas",
	topicsDescription:
		"Todos los canales que enumeran los transportes pub/sub vinculados — el bus en proceso y canales Redis cuando existan.",
	tColTopic: "Tema",
	tColTransport: "Transporte",
	tColSubscribers: "Suscriptores",
	tColRecent: "Recientes",
	tColLastActivity: "Última actividad",
	subscribersUnknown: "—",
	noRecent: "Sin historial",
	neverActive: "Nunca",
	emptyTopicsTitle: "Aún no hay temas",
	emptyTopicsDescription:
		"Los temas aparecen aquí cuando un transporte publica o se suscribe a un canal por primera vez.",
	unavailableTitle: "Señal no disponible",
	unavailableDescription: "Esta señal no se puede leer en el entorno actual.",
	publishTitle: "Publicar",
	publishDescription: "Envía un payload JSON a un tema por su id del console.",
	pTopic: "Tema",
	pTopicPlaceholder: "memory:cron.fires",
	pPayload: "Payload (JSON)",
	pPayloadHint: "Debe ser JSON válido — claves y valores entre comillas.",
	publish: "Publicar",
	publishing: "Publicando…",
	publishOk: "Mensaje publicado.",
	publishUnknown: "Id de tema desconocido — elige uno en la pestaña Temas.",
	publishUnavailable: "Transporte pub/sub no disponible en este entorno.",
	publishForbidden: "No permitido.",
	publishFailed: "La publicación falló.",
	invalidJson: "El payload no es JSON válido.",
};

const CATALOGS: Record<PubSubLocale, PubSubMessages> = { en, "pt-BR": ptBR, es };

export const isPubSubLocale = (locale: string): locale is PubSubLocale =>
	(PUBSUB_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const pubSubMessages = (locale: string): PubSubMessages =>
	CATALOGS[isPubSubLocale(locale) ? locale : BASE_LOCALE];
