import { Schema } from "effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import type { Driver } from "@ktb/driver-framework";

/** A transactional email. The sender address is deployment config owned
 * by the driver, never by the caller. */
export interface EmailMessage {
	readonly to: string;
	readonly subject: string;
	/** Plain-text body — always required; `html` is an optional rich alternative. */
	readonly text: string;
	readonly html?: string;
}

/**
 * Wire schema for an {@link EmailMessage} stored as an outbox payload
 * (kind {@link EMAIL_OUTBOX_KIND}) — the drainer's decode check at the
 * delivery edge. `html` stays optional; JSON round-trips drop
 * `undefined`, so absent is the only empty form producers write.
 */
export const EmailMessageSchema = Schema.Struct({
	to: Schema.String,
	subject: Schema.String,
	text: Schema.String,
	html: Schema.optionalKey(Schema.String),
});

/**
 * Outbox kind under which rendered email messages are queued for
 * reliable delivery (@ktb/outbox). Producers enqueue
 * `{ kind: EMAIL_OUTBOX_KIND, payload: EmailMessage }`; the
 * composition edge registers the matching deliverer.
 */
export const EMAIL_OUTBOX_KIND = "email";

/** Delivery was refused or failed at the provider. */
export class EmailSendError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = "EmailSendError";
	}
}

/**
 * Outbound email port: hands a message to the provider for delivery.
 * Provider-agnostic; impls live in sibling packages (e.g. @ktb/email-cloudflare).
 */
export interface EmailSender {
	/** Resolves once the provider accepted the message; rejects with
	 * {@link EmailSendError} otherwise. */
	send(message: EmailMessage): Promise<void>;
}

/**
 * Email service — the configured sender, or null when outbound email is
 * disabled for this deployment (flows that need it must degrade, not crash).
 */
export class Email extends Context.Service<Email, EmailSender | null>()("@ktb/email/Email") {}

/** Env slice read by Email port drivers (mirrors app-host AppEnv). */
export interface EmailDriverEnv {
	readonly EMAIL_STUB?: unknown;
	/** Provider send binding — opaque here; each driver narrows its own. */
	readonly EMAIL?: unknown;
	/** Sender address, e.g. "noreply@example.com". */
	readonly EMAIL_FROM?: string;
	/** SMTP server URL — selects the SMTP driver when set with EMAIL_FROM. */
	readonly SMTP_URL?: string;
	/** Socket transport for the SMTP driver — injected by the deploy
	 * target (cloudflare:sockets connect in workerd, node:net in dev:node). */
	readonly SMTP_CONNECT?: unknown;
}

/** True when a provider binding and its sender address are both bound. */
export const hasEmailProvider = (env: EmailDriverEnv): boolean =>
	Boolean(env.EMAIL) && Boolean(env.EMAIL_FROM);

/**
 * Disabled email driver: Email resolves to null. Last in the email driver
 * list — eligible only when no email mechanism (stub, SMTP, provider
 * binding) is configured.
 */
export const nullEmailDriver: Driver<EmailDriverEnv> = {
	id: "email-none",
	port: Email.key,
	provides: () => Layer.succeed(Email, null),
	when: (env) => !env.EMAIL_STUB && !env.SMTP_URL && !hasEmailProvider(env),
};
