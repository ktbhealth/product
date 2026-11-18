import { createCatalogT, renderMessage } from "@ktb/i18n";

import { APP_EN } from "./app-catalog.ts";

/**
 * Sign-up verification email (PL-008 Phase 5). Copy resolves from the
 * DB `app` namespace through the catalog `t` the composition root
 * injects (request locale → enabled-locale chain → fallbacks); the
 * English literals below are the last-resort fallback when no slice
 * resolved (tests, degenerate registries).
 */
export const verificationEmail = (
	input: {
		readonly name: string | null;
		readonly url: string;
	},
	t?: (key: string, params?: Readonly<Record<string, unknown>>) => string,
): { subject: string; text: string } => {
	const msg = (key: string, fallback: string, params?: Record<string, unknown>) => {
		if (t === undefined) return renderMessage(fallback, params ?? {}, "en");
		const resolved = t(`app.${key}`, params);
		return resolved === `app.${key}` ? renderMessage(fallback, params ?? {}, "en") : resolved;
	};
	return {
		subject: msg("email_verify_subject", "Confirm your email — KTB Health"),
		text: [
			input.name
				? msg("email_verify_greeting", "Hello, {name}.", { name: input.name })
				: msg("email_verify_greeting_anon", "Hello."),
			"",
			msg(
				"email_verify_body",
				"Confirm your email address to finish setting up your KTB Health account:",
			),
			input.url,
			"",
			msg(
				"email_verify_ignore",
				"If you did not create this account, you can ignore this message.",
			),
		].join("\n"),
	};
};

/**
 * Password-reset email — same composition contract as
 * {@link verificationEmail}: DB `app` catalog copy when a slice `t` is
 * injected, English literals otherwise.
 */
export const passwordResetEmail = (
	input: {
		readonly name: string | null;
		readonly url: string;
	},
	t?: (key: string, params?: Readonly<Record<string, unknown>>) => string,
): { subject: string; text: string } => {
	const msg = (key: string, fallback: string, params?: Record<string, unknown>) => {
		if (t === undefined) return renderMessage(fallback, params ?? {}, "en");
		const resolved = t(`app.${key}`, params);
		return resolved === `app.${key}` ? renderMessage(fallback, params ?? {}, "en") : resolved;
	};
	return {
		subject: msg("email_reset_subject", "Reset your password — KTB Health"),
		text: [
			input.name
				? msg("email_reset_greeting", "Hello, {name}.", { name: input.name })
				: msg("email_reset_greeting_anon", "Hello."),
			"",
			msg("email_reset_body", "Reset your KTB Health account password with the link below:"),
			input.url,
			"",
			msg(
				"email_reset_ignore",
				"If you did not request a password reset, you can ignore this message.",
			),
		].join("\n"),
	};
};

/** Build the catalog `t` for email copy — platform.ts resolves the
 * `app` namespace slice for the request locale and passes this in. */
export const emailCatalogT = (
	catalog: Readonly<Record<string, string>>,
	locale: string,
): ((key: string, params?: Readonly<Record<string, unknown>>) => string) =>
	createCatalogT({ ...APP_EN, ...catalog }, locale);
