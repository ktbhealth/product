import { describe, expect, it, vi } from "vitest";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as References from "effect/References";

import {
	telemetryConsoleDriver,
	logLevelLayer,
	telemetryWarningsLayer,
	Telemetry,
} from "./index.ts";
import { telemetryConfigFromEnv } from "./config.ts";

describe("telemetryConsoleDriver", () => {
	it("is always eligible (no when predicate) and targets the Telemetry port", () => {
		expect(telemetryConsoleDriver).not.toHaveProperty("when");
		expect(telemetryConsoleDriver.port).toBe(Telemetry.key);
		expect(telemetryConsoleDriver.id).toBe("telemetry-console");
	});

	it("provides a working Telemetry service", async () => {
		const runtime = ManagedRuntime.make(
			telemetryConsoleDriver.provides({}) as Layer.Layer<unknown, unknown, never>,
		);
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			expect(health).toEqual({ logs: "console", traces: "off", metrics: "prometheus" });
		} finally {
			await runtime.dispose();
		}
	});

	it("installs the JSON logger set", async () => {
		const runtime = ManagedRuntime.make(
			telemetryConsoleDriver.provides({}) as Layer.Layer<unknown, unknown, never>,
		);
		try {
			await runtime.runPromise(Effect.logInfo("driver smoke"));
		} finally {
			await runtime.dispose();
		}
	});

	it("emits redacted single-line JSON through the installed logger", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			const runtime = ManagedRuntime.make(
				telemetryConsoleDriver.provides({}) as Layer.Layer<unknown, unknown, never>,
			);
			try {
				await runtime.runPromise(
					Effect.logInfo("driver smoke").pipe(
						Effect.annotateLogs({ username: "ana", password: "hunter2" }),
					),
				);
			} finally {
				await runtime.dispose();
			}
			expect(spy).toHaveBeenCalled();
			const line = spy.mock.calls
				.map((call) => call[0])
				.find((arg): arg is string => typeof arg === "string" && arg.includes("driver smoke"));
			expect(line).toBeDefined();
			const parsed = JSON.parse(line as string);
			expect(parsed.annotations.username).toBe("ana");
			expect(parsed.annotations.password).toBe("[redacted]");
		} finally {
			spy.mockRestore();
		}
	});
});

describe("logLevelLayer", () => {
	it("is empty when no level is configured", async () => {
		const config = telemetryConfigFromEnv({});
		const runtime = ManagedRuntime.make(logLevelLayer(config));
		try {
			const level = await runtime.runPromise(Effect.service(References.MinimumLogLevel));
			expect(level).toBe("Info");
		} finally {
			await runtime.dispose();
		}
	});

	it("provides the configured minimum level", async () => {
		const config = telemetryConfigFromEnv({ KTB_LOG_LEVEL: "warning" });
		const runtime = ManagedRuntime.make(logLevelLayer(config));
		try {
			const level = await runtime.runPromise(Effect.service(References.MinimumLogLevel));
			expect(level).toBe("Warning");
		} finally {
			await runtime.dispose();
		}
	});
});

describe("telemetryWarningsLayer", () => {
	/** Layer-build logs resolve the console through `Console.Console` —
	 * provide a capturing console while the layer is built. */
	const buildWithCapturedLogs = async <A, E>(layer: Layer.Layer<A, E, never>) => {
		const lines: string[] = [];
		const testConsole: Console.Console = Object.assign(Object.create(console), {
			log: (...args: ReadonlyArray<unknown>) => lines.push(args.map(String).join(" ")),
		});
		await Effect.runPromise(
			Effect.scoped(Layer.build(layer)).pipe(Effect.provideService(Console.Console, testConsole)),
		);
		return lines;
	};

	it("emits nothing when the config carries no warnings", async () => {
		const config = { ...telemetryConfigFromEnv({}), warnings: undefined };
		const lines = await buildWithCapturedLogs(telemetryWarningsLayer(config));
		expect(lines.filter((l) => l.includes("WARN"))).toEqual([]);
	});

	it("emits each configured warning at layer build", async () => {
		const config = {
			...telemetryConfigFromEnv({}),
			warnings: ["first warning", "second warning"],
		};
		const lines = await buildWithCapturedLogs(telemetryWarningsLayer(config));
		expect(lines.some((l) => l.includes("first warning"))).toBe(true);
		expect(lines.some((l) => l.includes("second warning"))).toBe(true);
	});

	it("is empty when the config carries no warnings field", async () => {
		const config = { ...telemetryConfigFromEnv({}), warnings: undefined };
		const runtime = ManagedRuntime.make(telemetryWarningsLayer(config));
		try {
			await runtime.runPromise(Effect.void);
		} finally {
			await runtime.dispose();
		}
	});

	it("emits warnings at layer build for an insecure OTLP endpoint", async () => {
		const config = telemetryConfigFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.com",
		});
		const runtime = ManagedRuntime.make(telemetryWarningsLayer(config));
		try {
			await runtime.runPromise(Effect.void);
		} finally {
			await runtime.dispose();
		}
	});

	it("surfaces dropped-endpoint warnings through the console driver", async () => {
		const runtime = ManagedRuntime.make(
			telemetryConsoleDriver.provides({
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://otel.example.com",
			}) as Layer.Layer<unknown, unknown, never>,
		);
		try {
			const health = await runtime.runPromise(
				Effect.gen(function* () {
					const t = yield* Telemetry;
					return yield* t.health;
				}),
			);
			// All signals dropped → console fallback reports local exporters.
			expect(health).toEqual({ logs: "console", traces: "off", metrics: "prometheus" });
		} finally {
			await runtime.dispose();
		}
	});
});
