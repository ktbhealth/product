import { describe, expect, it } from "vitest";

import { heuristicAnamnesisDriver } from "@ktb/anamnesis-llm/drivers";
import { stubBotDriver } from "@ktb/bot";
import { nullCaptchaDriver } from "@ktb/captcha";
import { passthroughCipherDriver } from "@ktb/crypto-stub";
import { makeTestD1 } from "@ktb/db-testing";
import { nullEmailDriver } from "@ktb/email";
import type { Plugin } from "@ktb/kernel";
import { telemetryConsoleDriver } from "@ktb/observability";
import { PluginStates } from "@ktb/platform/plugin-states";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { buildApp, type BuildAppSpec } from "./index.ts";

/**
 * Composition seam (E.16): `buildApp` assembles a runnable app from an
 * explicit plugin subset + driver list + extra core layers — the same
 * pipeline `createApp` runs for the full registry. These tests compose
 * a two-plugin app on stub drivers only: no recall/turnstile/smtp/OTLP
 * env is bound, so every required port resolves to its null/stub impl.
 */

class Echo extends Context.Service<Echo, { readonly value: string }>()("@ktb/app-host-test/Echo") {}

class Extra extends Context.Service<Extra, { readonly tag: string }>()(
	"@ktb/app-host-test/Extra",
) {}

const echoPlugin: Plugin = {
	id: "test.echo",
	services: Layer.succeed(Echo, { value: "echo-ok" }),
};

const markerPlugin: Plugin = { id: "test.marker" };

/** Stub-only driver set covering every REQUIRED port
 * (Bot/Captcha/Email/Telemetry/AnamnesisEngine/EntityCipher); optional
 * ports (EvalRunner, LlmPort, …) simply stay unbound. */
const stubDrivers = [
	stubBotDriver,
	nullCaptchaDriver,
	nullEmailDriver,
	telemetryConsoleDriver,
	heuristicAnamnesisDriver,
	passthroughCipherDriver,
];

const testEnv = {
	DB: makeTestD1(),
	BETTER_AUTH_SECRET: "test-secret-at-least-32-characters-long!!",
	BETTER_AUTH_URL: "http://localhost:3000",
};

const build = (overrides: Partial<BuildAppSpec> = {}) =>
	buildApp({
		env: testEnv,
		plugins: [echoPlugin, markerPlugin],
		drivers: stubDrivers,
		cqrsGroups: { queryGroups: [], commandGroups: [] },
		...overrides,
	});

describe("buildApp", () => {
	it("composes a plugin subset with stub drivers into a runnable app", async () => {
		const app = build();
		try {
			expect(app.plugins).toEqual([echoPlugin, markerPlugin]);
			// Plugin-provided services resolve inside the runtime.
			await expect(app.run(Effect.map(Echo, (e) => e.value))).resolves.toBe("echo-ok");
			// Registry-derived services are built from the SUBSET, not the
			// filesystem-discovered registry.
			const enabled = await app.run(Effect.flatMap(PluginStates, (states) => states.enabledIds()));
			expect(enabled).toEqual(new Set(["test.echo", "test.marker"]));
		} finally {
			await app.runtime.dispose();
		}
	});

	it("merges coreLayers into the core layer for the app runtime", async () => {
		const app = build({
			coreLayers: [Layer.succeed(Extra, { tag: "core-layer" })],
		});
		try {
			await expect(app.run(Effect.map(Extra, (e) => e.tag))).resolves.toBe("core-layer");
		} finally {
			await app.runtime.dispose();
		}
	});

	it("honours AppOptions (tenant resolver) like createApp", async () => {
		const seen: unknown[] = [];
		const app = build({
			options: {
				tenantResolver: {
					resolve: (selector) => {
						seen.push(selector);
						return Effect.succeed(null);
					},
				},
			},
		});
		try {
			await expect(
				app.runAs({ id: "u1" }, Effect.succeed("ok"), { slug: "clinic-a" }),
			).resolves.toBe("ok");
			expect(seen).toEqual([{ slug: "clinic-a" }]);
		} finally {
			await app.runtime.dispose();
		}
	});
});
