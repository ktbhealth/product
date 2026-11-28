import * as Context from "effect/Context";
import { Event } from "@effect-server-utils/cqrs";
import { paramMessage } from "@ktb/i18n";
import type { Plugin } from "@ktb/kernel";

/**
 * Notification-ingestion port — the `notificationIngestions` manifest
 * field's contract and the registry the consumer (@ktb/notifications)
 * subscribes from.
 *
 * Producers (patients, consultations, agenda, …) declare which domain
 * events project into console-notification drafts by putting
 * `notificationIngestion(eventDef, project)` entries on their plugin
 * manifest — additive manifest data like `pipelines`/`orchestrations`,
 * NOT the JSON `contributions` channel: event defs and projectors are
 * code, so they cannot ride `PluginContribution.meta`. The app host
 * collects every plugin's entries into the `NotificationIngestions`
 * service at composition (`makeNotificationIngestions`), and the
 * notifications plugin's service layer subscribes each entry on the
 * app-wide `EventBus` — no `requiredDeps` edge between producer and
 * consumer is needed: an absent producer simply contributes no
 * entries.
 *
 * Ordering: entries collect in plugin topo order, declaration order
 * within a plugin. Subscription order across distinct event defs is
 * unobservable (each tag routes to its own handlers); entries for the
 * SAME event def run in collection order.
 *
 * Enablement: like the other composition-time registries
 * (DocumentCollections, TriggerDefinitions, …) collection ignores
 * PluginStates — a disabled plugin's entries are still subscribed.
 * That is harmless: its service layer never builds, so the event is
 * never dispatched.
 */

/** The persisted notification row shape producers project into —
 * owned here so manifests can type their projectors without importing
 * the notifications plugin (which would be a package cycle). */
export interface NotificationDraft {
	readonly userId: string;
	readonly kind: string;
	readonly title: string;
	readonly body?: string;
	readonly payload?: string;
}

/** Per-event context the consumer resolves before invoking a
 * projector: `zk` is the owning tenant's zero-knowledge flag (under ZK
 * the server cannot read record content, so drafts must be
 * metadata-only — T-149) and `locale` is the actor's UI locale at
 * ingest time (titles are persisted localized). */
export interface NotificationIngestContext {
	readonly zk: boolean;
	readonly locale: string;
}

/** One event → draft projection a plugin contributes. `project` is
 * typed against its own event at the `notificationIngestion` call
 * site; the erased signature lets heterogeneous entries share one
 * array — the consumer casts back per entry, same erasure the
 * hand-rolled event map used. */
export interface NotificationIngestion {
	readonly event: Event.Any;
	readonly project: (event: unknown, ctx: NotificationIngestContext) => NotificationDraft;
}

/**
 * Declare one ingestion entry. Validates the event def eagerly —
 * packaging bugs surface at module load, not first dispatch.
 */
export const notificationIngestion = <E extends Event.Any>(
	event: E,
	project: (event: Event.Type<E>, ctx: NotificationIngestContext) => NotificationDraft,
): NotificationIngestion => {
	if (!Event.is(event)) {
		throw new Error("notificationIngestion: first argument must be an Event def");
	}
	if (typeof project !== "function") {
		throw new Error(`notificationIngestion: projector for "${event.tag}" must be a function`);
	}
	return {
		event,
		// The bus hands back the decoded payload; each projector was typed
		// against its own event at the contribution site.
		project: project as (event: unknown, ctx: NotificationIngestContext) => NotificationDraft,
	};
};

// ---------- ingest-time copy ----------

/**
 * Persisted notification titles/bodies, one catalog per locale — the
 * copy projectors resolve at ingest. Split from the notifications
 * plugin's UI catalog so producer plugins can render drafts without
 * importing it; the plugin's `NotificationMessages` spreads these
 * same catalogs so the DB-exported i18n surface stays unchanged.
 */
export interface NotificationIngestMessages {
	/** Persisted notification titles, keyed by event kind. */
	readonly titles: {
		readonly patientCreated: string;
		readonly patientDeleted: string;
		readonly consultationCreated: string;
		readonly appointmentReminder: string;
	};
	/** Persisted notification bodies, keyed by event kind. */
	readonly bodies: {
		/** "Patient name — 14:30" for plaintext tenants. */
		readonly appointmentReminder: (name: string, time: string) => string;
		/** Metadata-only variant under ZK — the patient's `v1.` name
		 * envelope never lands in the row; only the schedule time. */
		readonly appointmentReminderZk: (time: string) => string;
	};
}

export const NOTIFICATION_INGEST_LOCALES = ["en", "pt-BR", "es"] as const;
export type NotificationIngestLocale = (typeof NOTIFICATION_INGEST_LOCALES)[number];
const INGEST_BASE_LOCALE: NotificationIngestLocale = "en";

const en: NotificationIngestMessages = {
	titles: {
		patientCreated: "Patient created",
		patientDeleted: "Patient deleted",
		consultationCreated: "Consultation started",
		appointmentReminder: "Appointment starting soon",
	},
	bodies: {
		appointmentReminder: paramMessage("en", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("en", "Starts at {time}", ["time"]),
	},
};

const ptBR: NotificationIngestMessages = {
	titles: {
		patientCreated: "Paciente criado",
		patientDeleted: "Paciente excluído",
		consultationCreated: "Consulta iniciada",
		appointmentReminder: "Consulta prestes a começar",
	},
	bodies: {
		appointmentReminder: paramMessage("pt-BR", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("pt-BR", "Começa às {time}", ["time"]),
	},
};

const es: NotificationIngestMessages = {
	titles: {
		patientCreated: "Paciente creado",
		patientDeleted: "Paciente eliminado",
		consultationCreated: "Consulta iniciada",
		appointmentReminder: "Consulta a punto de comenzar",
	},
	bodies: {
		appointmentReminder: paramMessage("es", "{name} — {time}", ["name", "time"]),
		appointmentReminderZk: paramMessage("es", "Empieza a las {time}", ["time"]),
	},
};

const INGEST_CATALOGS: Record<NotificationIngestLocale, NotificationIngestMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

/** Catalog for a locale tag; unknown tags get the base locale — same
 * fallback contract as the notifications plugin's UI catalog. */
export const notificationIngestMessages = (locale: string): NotificationIngestMessages =>
	INGEST_CATALOGS[
		(NOTIFICATION_INGEST_LOCALES as readonly string[]).includes(locale)
			? (locale as NotificationIngestLocale)
			: INGEST_BASE_LOCALE
	];

// ---------- registry ----------

/** The collected registry the notifications service layer consumes —
 * every plugin's `notificationIngestions` entries in topo order. */
export class NotificationIngestions extends Context.Service<
	NotificationIngestions,
	{
		readonly ingestions: readonly NotificationIngestion[];
	}
>()("@ktb/notifications-port/NotificationIngestions") {}

/**
 * Collect every `notificationIngestions` entry across `plugins` (pass
 * the topo-ordered registry — `orderPlugins`/`ctx.plugins` output).
 * Entries are code, not data: there is no duplicate-key guard — two
 * plugins may legitimately project the same event differently, and
 * both subscriptions run.
 */
export const makeNotificationIngestions = (
	plugins: readonly Plugin[],
): { readonly ingestions: readonly NotificationIngestion[] } => ({
	ingestions: plugins.flatMap((plugin) => plugin.notificationIngestions ?? []),
});
