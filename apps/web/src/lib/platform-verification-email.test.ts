import { describe, expect, it, vi } from "vitest";

import { env } from "cloudflare:workers";

// The Email driver is selected once, when platform.ts composes the app:
// bind the stub first so the verification-email callback actually runs.
// `failLocales` forces the request-locale catalog lookup inside the
// callback to fail — platform.ts must degrade to `t = undefined` and
// still send the English literals (email must not break sign-up).
// `emptyChain` makes the resolved locale chain empty so the
// `chain.locales[0] ?? DEFAULT_LOCALE` fallback branch is exercised.
const hoisted = vi.hoisted(() => ({ failLocales: true, emptyChain: false }));

vi.mock("@ktb/i18n-plugin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n-plugin")>();
	return {
		...actual,
		listEnabledLocales: (...args: Parameters<typeof actual.listEnabledLocales>) =>
			hoisted.failLocales
				? Promise.reject(new Error("i18n_locales unavailable"))
				: actual.listEnabledLocales(...args),
	};
});

vi.mock("@ktb/i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n")>();
	return {
		...actual,
		resolveRequestLocales: (
			...args: Parameters<typeof actual.resolveRequestLocales>
		): ReturnType<typeof actual.resolveRequestLocales> =>
			hoisted.emptyChain
				? { locales: [], defaultLocale: "en" }
				: actual.resolveRequestLocales(...args),
	};
});

env.EMAIL_STUB = "1";

const { auth } = await import("./platform.ts");

const sendVerification = () => {
	const verification = (
		auth.options as unknown as {
			emailVerification?: {
				sendVerificationEmail?: (input: {
					user: { id: string; email: string; name?: string | null };
					url: string;
					token: string;
				}) => Promise<void>;
			};
		}
	).emailVerification?.sendVerificationEmail;
	expect(verification).toBeDefined();
	return verification!({
		user: { id: "u1", email: "vera@x.com", name: "Vera" },
		url: "http://localhost:3000/api/auth/verify-email?token=t",
		token: "t",
	});
};

describe("verificationEmail i18n", () => {
	it("sends English literals when catalog resolution fails", async () => {
		hoisted.failLocales = true;
		hoisted.emptyChain = false;
		await expect(sendVerification()).resolves.toBeUndefined();
	});

	it("resolves the app catalog when the locale chain resolves", async () => {
		hoisted.failLocales = false;
		hoisted.emptyChain = false;
		try {
			await expect(sendVerification()).resolves.toBeUndefined();
		} finally {
			hoisted.failLocales = true;
		}
	});

	it("falls back to the default locale when the resolved chain is empty", async () => {
		hoisted.failLocales = false;
		hoisted.emptyChain = true;
		try {
			await expect(sendVerification()).resolves.toBeUndefined();
		} finally {
			hoisted.failLocales = true;
			hoisted.emptyChain = false;
		}
	});
});
