import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { Captcha, type CaptchaDriverEnv, type CaptchaVerifier } from "@ktb/captcha";
import { makeTurnstileVerifier, turnstileCaptchaDriver } from "./index.ts";

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
type FetchMock = () => Promise<{ ok: boolean; json: () => Promise<{ success: boolean }> }>;
const okFetch = () =>
	vi.fn<FetchMock>(async () => ({ ok: true, json: async () => ({ success: true }) }));
const lastCall = () =>
	(fetch as ReturnType<typeof vi.fn>).mock.calls.at(-1) as [string, RequestInit];

afterEach(() => vi.unstubAllGlobals());

describe("turnstile verifier", () => {
	it("fails closed without a token", async () => {
		vi.stubGlobal("fetch", okFetch());
		const v = makeTurnstileVerifier("secret");
		expect(await v.verify(undefined)).toBe(false);
		expect(await v.verify("")).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns true on success", async () => {
		vi.stubGlobal("fetch", okFetch());
		const v = makeTurnstileVerifier("secret");
		expect(await v.verify("tok", "1.2.3.4")).toBe(true);
		const [url, init] = lastCall();
		expect(url).toBe(SITEVERIFY_URL);
		expect(init.method).toBe("POST");
		const params = new URLSearchParams(init.body as URLSearchParams);
		expect(params.get("secret")).toBe("secret");
		expect(params.get("response")).toBe("tok");
		expect(params.get("remoteip")).toBe("1.2.3.4");
	});

	it("omits remoteip when absent", async () => {
		vi.stubGlobal("fetch", okFetch());
		await makeTurnstileVerifier("s").verify("tok");
		const [, init] = lastCall();
		expect(new URLSearchParams(init.body as URLSearchParams).get("remoteip")).toBeNull();
	});

	it("returns false on http error, non-success and network failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ success: true }) })),
		);
		expect(await makeTurnstileVerifier("s").verify("t")).toBe(false);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ success: false }) })),
		);
		expect(await makeTurnstileVerifier("s").verify("t")).toBe(false);

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Promise.reject(new Error("net"))),
		);
		expect(await makeTurnstileVerifier("s").verify("t")).toBe(false);
	});
});

describe("turnstileCaptchaDriver", () => {
	it("is eligible only with a secret and no CAPTCHA_STUB", () => {
		expect(turnstileCaptchaDriver.id).toBe("captcha-turnstile");
		expect(turnstileCaptchaDriver.port).toBe(Captcha.key);
		expect(turnstileCaptchaDriver.when?.({})).toBe(false);
		expect(turnstileCaptchaDriver.when?.({ TURNSTILE_SECRET_KEY: "" })).toBe(false);
		expect(turnstileCaptchaDriver.when?.({ TURNSTILE_SECRET_KEY: "k" })).toBe(true);
		expect(turnstileCaptchaDriver.when?.({ CAPTCHA_STUB: "1", TURNSTILE_SECRET_KEY: "k" })).toBe(
			false,
		);
	});

	it("provides a turnstile-backed layer", () => {
		expect(turnstileCaptchaDriver.provides({ TURNSTILE_SECRET_KEY: "s3cr3t" })).toBeDefined();
		expect(turnstileCaptchaDriver.provides({})).toBeDefined();
	});

	it("binds the env secret into the provided layer", async () => {
		vi.stubGlobal("fetch", okFetch());
		const captchaFor = async (env: CaptchaDriverEnv): Promise<CaptchaVerifier> => {
			const captcha = await Effect.runPromise(
				Effect.service(Captcha).pipe(
					Effect.provide(
						turnstileCaptchaDriver.provides(env) as Layer.Layer<Captcha, never, never>,
					),
				),
			);
			expect(captcha).not.toBeNull();
			return captcha as CaptchaVerifier;
		};

		const withSecret = await captchaFor({ TURNSTILE_SECRET_KEY: "s3cr3t" });
		await withSecret.verify("tok");
		expect(new URLSearchParams(lastCall()[1].body as URLSearchParams).get("secret")).toBe("s3cr3t");

		const withoutSecret = await captchaFor({});
		await withoutSecret.verify("tok");
		expect(new URLSearchParams(lastCall()[1].body as URLSearchParams).get("secret")).toBe("");
	});
});
