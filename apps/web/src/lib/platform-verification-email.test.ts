import { describe, expect, it, vi } from "vitest";

import { env } from "cloudflare:workers";

// The Email driver is selected once, when platform.ts composes the app:
// bind the stub first so the verification-email callback actually runs
// (its i18n lookup then fails below → English literals are sent).
env.EMAIL_STUB = "1";

// Force the request-locale catalog lookup inside the verificationEmail
// callback to fail — platform.ts must degrade to `t = undefined` and
// still send the English literals (email must not break sign-up).
vi.mock("@ktb/i18n-plugin", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/i18n-plugin")>();
	return {
		...actual,
		listEnabledLocales: () => Promise.reject(new Error("i18n_locales unavailable")),
	};
});

const { auth } = await import("./platform.ts");

describe("verificationEmail i18n fallback", () => {
	it("sends English literals when catalog resolution fails", async () => {
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
		await expect(
			verification!({
				user: { id: "u1", email: "vera@x.com", name: "Vera" },
				url: "http://localhost:3000/api/auth/verify-email?token=t",
				token: "t",
			}),
		).resolves.toBeUndefined();
	});
});
