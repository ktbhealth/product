import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { initClientTelemetry, instrumentRouter } from "./client.ts";
import type { ClientTelemetryEvent } from "./ingest.ts";

/**
 * Node-env tests: the module under test is browser code, so every test
 * installs minimal `window`/`document` fakes via `vi.stubGlobal` and the
 * module's `globalThis` singletons are reset between tests.
 */

const GLOBAL_KEY = Symbol.for("ktb.observability.clientTelemetry");
const FETCH_PATCHED_KEY = Symbol.for("ktb.observability.fetchPatched");
const FETCH_ORIGINAL_KEY = Symbol.for("ktb.observability.fetchOriginal");

type Listener = (event: never) => void;

interface FakeBrowser {
	readonly win: {
		location: { pathname: string; origin: string; href: string };
		navigator: { sendBeacon: Mock<(...args: any[]) => any> };
		fetch: Mock<(...args: any[]) => any>;
		addEventListener: (type: string, fn: Listener) => void;
		removeEventListener: (type: string, fn: Listener) => void;
	};
	readonly doc: {
		visibilityState: string;
		addEventListener: (type: string, fn: Listener) => void;
		removeEventListener: (type: string, fn: Listener) => void;
	};
	emitWindow: (type: string, event?: unknown) => void;
	emitDocument: (type: string, event?: unknown) => void;
	windowListeners: Map<string, Set<Listener>>;
	documentListeners: Map<string, Set<Listener>>;
}

const installBrowser = (): FakeBrowser => {
	const windowListeners = new Map<string, Set<Listener>>();
	const documentListeners = new Map<string, Set<Listener>>();
	const addTo =
		(map: Map<string, Set<Listener>>) =>
		(type: string, fn: Listener): void => {
			let set = map.get(type);
			if (set === undefined) {
				set = new Set();
				map.set(type, set);
			}
			set.add(fn);
		};
	const removeFrom =
		(map: Map<string, Set<Listener>>) =>
		(type: string, fn: Listener): void => {
			map.get(type)?.delete(fn);
		};
	const win = {
		location: {
			pathname: "/start",
			origin: "http://localhost",
			href: "http://localhost/start",
		},
		navigator: { sendBeacon: vi.fn<(...args: any[]) => boolean>(() => true) },
		fetch: vi.fn<(...args: any[]) => any>(async () => ({ status: 200, ok: true })),
		addEventListener: addTo(windowListeners),
		removeEventListener: removeFrom(windowListeners),
	};
	const doc = {
		visibilityState: "visible",
		addEventListener: addTo(documentListeners),
		removeEventListener: removeFrom(documentListeners),
	};
	vi.stubGlobal("window", win);
	vi.stubGlobal("document", doc);
	return {
		win,
		doc,
		windowListeners,
		documentListeners,
		emitWindow: (type, event) => {
			for (const fn of windowListeners.get(type) ?? []) {
				(fn as (e: unknown) => void)(event ?? { type });
			}
		},
		emitDocument: (type, event) => {
			for (const fn of documentListeners.get(type) ?? []) {
				(fn as (e: unknown) => void)(event ?? { type });
			}
		},
	};
};

const resetSingletons = (): void => {
	const store = globalThis as Record<symbol, unknown>;
	delete store[GLOBAL_KEY];
	delete store[FETCH_PATCHED_KEY];
	delete store[FETCH_ORIGINAL_KEY];
};

/** The unwrapped fetch mock — `window.fetch` is replaced by the
 * instrumented wrapper on init, so assertions on call args go through
 * the original captured by the patch (exposed via the module's global
 * symbol). */
const underlyingFetch = (): Mock<(...args: any[]) => any> =>
	(globalThis as Record<symbol, unknown>)[FETCH_ORIGINAL_KEY] as Mock<(...args: any[]) => any>;

/** Parse the JSON body of the most recent sendBeacon call. */
const beaconEvents = (sendBeacon: Mock<(...args: any[]) => any>): ClientTelemetryEvent[] => {
	const call = sendBeacon.mock.calls.at(-1);
	expect(call).toBeDefined();
	const body = call?.[1] as string;
	return (JSON.parse(body) as { events: ClientTelemetryEvent[] }).events;
};

beforeEach(() => {
	vi.useFakeTimers();
	resetSingletons();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	resetSingletons();
});

describe("initClientTelemetry", () => {
	it("returns a no-op telemetry during SSR (no window/document)", () => {
		const telemetry = initClientTelemetry();
		expect(() => telemetry.report({ type: "event", name: "x" })).not.toThrow();
		expect(() => telemetry.dispose()).not.toThrow();
	});

	it("is idempotent — second call returns the existing instance", () => {
		installBrowser();
		const first = initClientTelemetry({ sampleRate: 0.5 });
		const second = initClientTelemetry({ sampleRate: 0 });
		expect(second).toBe(first);
		first.dispose();
	});

	it("attaches service.name to reported events", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ serviceName: "web-app" });
		telemetry.report({ type: "event", name: "custom", attributes: { a: 1 } });
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.attributes).toMatchObject({ "service.name": "web-app", a: 1 });
		telemetry.dispose();
	});
});

describe("report()", () => {
	it("enqueues valid events and flushes on the interval", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "custom.event", path: "/p?x=1" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			type: "event",
			name: "custom.event",
			path: "/p",
		});
		expect(typeof events[0]?.timestamp).toBe("number");
		telemetry.dispose();
	});

	it("drops events with an invalid type or missing name", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "bogus" as ClientTelemetryEvent["type"], name: "x" });
		telemetry.report({ type: "event", name: "" });
		telemetry.report({ type: "event", name: 42 as unknown as string });
		vi.advanceTimersByTime(10_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("truncates names longer than 120 chars", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "n".repeat(200) });
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.name).toHaveLength(120);
		telemetry.dispose();
	});

	it("accepts every reportable event type", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		for (const type of ["event", "error", "navigation", "request"] as const) {
			telemetry.report({ type, name: `${type}.x` });
		}
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.map((e) => e.type)).toEqual(["event", "error", "navigation", "request"]);
		telemetry.dispose();
	});

	it("drops everything when sampleRate is 0", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ sampleRate: 0 });
		telemetry.report({ type: "event", name: "never" });
		vi.advanceTimersByTime(10_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("clamps out-of-range sample rates", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ sampleRate: 42 });
		telemetry.report({ type: "event", name: "kept" });
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});
});

describe("error capture", () => {
	it("reports window error events as client.error", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		browser.emitWindow("error", {
			message: "boom",
			error: new Error("boom"),
		});
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({
			type: "error",
			name: "client.error",
			message: "boom",
			path: "/start",
		});
		expect(typeof event?.stack).toBe("string");
		telemetry.dispose();
	});

	it("handles error events without an Error object", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		browser.emitWindow("error", { message: "" });
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.message).toBe("Unknown error");
		expect(event?.stack).toBeUndefined();
		telemetry.dispose();
	});

	it("reports unhandledrejection with Error and non-Error reasons", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		browser.emitWindow("unhandledrejection", { reason: new Error("rej") });
		browser.emitWindow("unhandledrejection", { reason: "plain string" });
		browser.emitWindow("unhandledrejection", { reason: { weird: true } });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events).toHaveLength(3);
		expect(events[0]?.message).toBe("rej");
		expect(events[1]?.message).toBe("plain string");
		expect(events[2]?.message).toBe('{"weird":true}');
		telemetry.dispose();
	});
});

describe("batching & flush", () => {
	it("flushes early when the queue reaches maxBatchSize", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ maxBatchSize: 3 });
		telemetry.report({ type: "event", name: "a" });
		telemetry.report({ type: "event", name: "b" });
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.report({ type: "event", name: "c" });
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		expect(beaconEvents(browser.win.navigator.sendBeacon)).toHaveLength(3);
		telemetry.dispose();
	});

	it("caps the queue at 200 events, dropping the oldest", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ maxBatchSize: 1_000, flushIntervalMs: 60_000 });
		for (let i = 0; i < 210; i++) {
			telemetry.report({ type: "event", name: `e${i}` });
		}
		vi.advanceTimersByTime(60_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events).toHaveLength(200);
		expect(events[0]?.name).toBe("e10");
		expect(events.at(-1)?.name).toBe("e209");
		telemetry.dispose();
	});

	it("falls back to keepalive fetch when sendBeacon is missing", async () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon = undefined as never;
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "via-fetch" });
		vi.advanceTimersByTime(5_000);
		const fetchMock = underlyingFetch();
		const ingestCall = fetchMock.mock.calls.find((call) => call[0] === "/api/telemetry");
		expect(ingestCall).toBeDefined();
		const init = ingestCall?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.keepalive).toBe(true);
		expect(JSON.parse(init.body as string).events[0].name).toBe("via-fetch");
		await Promise.resolve();
		telemetry.dispose();
	});

	it("falls back to fetch when sendBeacon returns false", () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon.mockReturnValue(false);
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "beacon-fail" });
		vi.advanceTimersByTime(5_000);
		expect(underlyingFetch()).toHaveBeenCalledWith(
			"/api/telemetry",
			expect.objectContaining({ method: "POST", keepalive: true }),
		);
		telemetry.dispose();
	});

	it("flushes on pagehide and on visibilitychange:hidden", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "bye" });
		browser.emitWindow("pagehide");
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);

		telemetry.report({ type: "event", name: "hidden" });
		browser.doc.visibilityState = "hidden";
		browser.emitDocument("visibilitychange");
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(2);

		// visible → no flush
		telemetry.report({ type: "event", name: "visible" });
		browser.doc.visibilityState = "visible";
		browser.emitDocument("visibilitychange");
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(2);
		telemetry.dispose();
	});

	it("dispose flushes pending events, removes listeners and restores fetch", async () => {
		const browser = installBrowser();
		const originalFetch = browser.win.fetch;
		const telemetry = initClientTelemetry();
		expect(browser.win.fetch).not.toBe(originalFetch);
		telemetry.report({ type: "event", name: "final" });
		telemetry.dispose();
		expect(beaconEvents(browser.win.navigator.sendBeacon)[0]?.name).toBe("final");
		expect(browser.win.fetch).toBe(originalFetch);
		// Listeners detached — error events no longer enqueue.
		browser.emitWindow("error", { message: "after-dispose" });
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		// report() after dispose is a no-op.
		telemetry.report({ type: "event", name: "zombie" });
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		await Promise.resolve();
	});

	it("survives a throwing cleanup during dispose", () => {
		const browser = installBrowser();
		browser.win.removeEventListener = vi.fn<(...args: any[]) => void>(() => {
			throw new Error("cleanup boom");
		}) as never;
		const telemetry = initClientTelemetry();
		expect(() => telemetry.dispose()).not.toThrow();
	});
});

describe("fetch instrumentation", () => {
	it("injects traceparent + x-request-id and records a request event", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		const response = { status: 201, ok: true };
		fetchMock.mockResolvedValue(response);

		const result = await browser.win.fetch("http://localhost/api/users?secret=1", {
			method: "POST",
			headers: { "x-custom": "keep-me" },
		});
		expect(result).toBe(response);

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		const headers = new Headers(init.headers);
		expect(headers.get("x-custom")).toBe("keep-me");
		const traceparent = headers.get("traceparent");
		expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		expect(headers.get("x-request-id")).toBeTruthy();

		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({
			type: "request",
			name: "web.request",
			path: "/api/users",
			status: 201,
			traceparent,
			requestId: headers.get("x-request-id"),
		});
		expect(event?.attributes).toEqual({ method: "POST" });
		expect(event?.durationMs).toBeGreaterThanOrEqual(0);
		telemetry.dispose();
	});

	it("records cross-origin fetches without injecting trace headers", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		fetchMock.mockResolvedValue({ status: 200, ok: true });

		await browser.win.fetch("https://cdn.example.com/lib.js", {
			method: "GET",
			headers: { "x-custom": "keep" },
		});
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		// Headers pass through untouched — no traceparent/x-request-id, so
		// no CORS preflight is triggered on third-party requests.
		const headers = new Headers(init?.headers);
		expect(headers.get("traceparent")).toBeNull();
		expect(headers.get("x-request-id")).toBeNull();
		expect(headers.get("x-custom")).toBe("keep");

		// The request is still timed and recorded — minus trace ids.
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({
			type: "request",
			name: "web.request",
			path: "/lib.js",
			status: 200,
		});
		expect(event?.traceparent).toBeUndefined();
		expect(event?.requestId).toBeUndefined();
		telemetry.dispose();
	});

	it("treats protocol-relative cross-origin URLs as cross-origin", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		fetchMock.mockResolvedValue({ status: 200, ok: true });
		await browser.win.fetch("//cdn.example.com/x");
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(new Headers(init?.headers).get("traceparent")).toBeNull();
		telemetry.dispose();
	});

	it("resolves relative URLs against window.location", async () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		await browser.win.fetch("/api/relative");
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.path).toBe("/api/relative");
		telemetry.dispose();
	});

	it("injects no trace headers when window.location is unavailable", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		fetchMock.mockResolvedValue({ status: 200, ok: true });
		(browser.win as { location?: unknown }).location = undefined;

		await browser.win.fetch("http://localhost/api/x");
		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		// No resolvable origin → treated as cross-origin: no injected
		// traceparent/x-request-id.
		const headers = new Headers(init?.headers);
		expect(headers.get("traceparent")).toBeNull();
		expect(headers.get("x-request-id")).toBeNull();
		telemetry.dispose();
	});

	it("handles Request-like inputs, preserving method and merging headers", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		const requestLike = {
			url: "http://localhost/api/thing",
			method: "PUT",
			headers: new Headers({ "x-req": "yes" }),
		};
		await browser.win.fetch(requestLike as unknown as RequestInfo);
		const [, init] = fetchMock.mock.calls[0] as [unknown, RequestInit];
		const headers = new Headers(init.headers);
		expect(headers.get("x-req")).toBe("yes");
		expect(headers.get("traceparent")).toBeTruthy();
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.attributes).toEqual({ method: "PUT" });
		telemetry.dispose();
	});

	it("records status 0 and rethrows when fetch rejects", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		const failure = new Error("network down");
		fetchMock.mockRejectedValue(failure);
		await expect(browser.win.fetch("http://localhost/api/fail")).rejects.toBe(failure);
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({ type: "request", status: 0, path: "/api/fail" });
		telemetry.dispose();
	});

	it("records status 0 and rethrows on synchronous fetch throw", () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		const failure = new Error("sync boom");
		fetchMock.mockImplementation(() => {
			throw failure;
		});
		expect(() => browser.win.fetch("http://localhost/api/sync")).toThrow(failure);
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({ type: "request", status: 0 });
		telemetry.dispose();
	});

	it("does not instrument calls to the telemetry endpoint itself", async () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon = undefined as never;
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "trigger" });
		vi.advanceTimersByTime(5_000);
		// Exactly one fetch call (the flush) — and its headers carry no
		// injected traceparent because endpoint calls skip instrumentation.
		expect(underlyingFetch()).toHaveBeenCalledTimes(1);
		const [, init] = underlyingFetch().mock.calls[0] as [string, RequestInit];
		expect(new Headers(init.headers).get("traceparent")).toBeNull();
		await Promise.resolve();
		telemetry.dispose();
	});

	it("passes through unmodified when header inspection throws", async () => {
		const browser = installBrowser();
		const fetchMock = browser.win.fetch;
		const telemetry = initClientTelemetry();
		const evil = {
			get url(): string {
				throw new Error("nope");
			},
		};
		await browser.win.fetch(evil as unknown as RequestInfo);
		// Original fetch received the raw input and init untouched.
		const [input, init] = fetchMock.mock.calls[0] as [unknown, unknown];
		expect(input).toBe(evil);
		expect(init).toBeUndefined();
		telemetry.dispose();
	});

	it("wraps fetch only once across dispose/re-init cycles", async () => {
		const browser = installBrowser();
		const first = initClientTelemetry();
		const wrapped = browser.win.fetch;
		first.dispose();
		expect(browser.win.fetch).not.toBe(wrapped);
		const second = initClientTelemetry();
		expect(browser.win.fetch).not.toBe(wrapped);
		second.dispose();
	});

	it("does not patch when window.fetch is missing", () => {
		installBrowser();
		(window as { fetch?: unknown }).fetch = undefined;
		const telemetry = initClientTelemetry();
		expect(() => telemetry.report({ type: "event", name: "ok" })).not.toThrow();
		vi.advanceTimersByTime(5_000);
		// No fetch → no fallback delivery, but no crash either.
		telemetry.dispose();
	});
});

describe("instrumentRouter", () => {
	const makeRouter = () => {
		const handlers = new Map<string, (event: { type?: string }) => void>();
		const unsubscribes = vi.fn<() => void>();
		const router = {
			subscribe: vi.fn<(eventType: string, fn: (event: { type?: string }) => void) => () => void>(
				(eventType, fn) => {
					handlers.set(eventType, fn);
					return unsubscribes;
				},
			),
			state: { location: { pathname: "/new-page" } },
		};
		return { router, handlers, unsubscribes };
	};

	it("returns undefined for routers without subscribe", () => {
		expect(instrumentRouter({})).toBeUndefined();
		expect(instrumentRouter(null as never)).toBeUndefined();
		expect(instrumentRouter({ subscribe: "nope" } as never)).toBeUndefined();
	});

	it("measures navigation from onBeforeNavigate to onResolved", () => {
		const { router, handlers } = makeRouter();
		const sink = vi.fn<(event: ClientTelemetryEvent) => void>();
		instrumentRouter(router, sink);
		expect(router.subscribe).toHaveBeenCalledWith("onBeforeNavigate", expect.any(Function));
		expect(router.subscribe).toHaveBeenCalledWith("onResolved", expect.any(Function));

		handlers.get("onBeforeNavigate")?.({ type: "onBeforeNavigate" });
		vi.advanceTimersByTime(120);
		handlers.get("onResolved")?.({ type: "onResolved" });

		expect(sink).toHaveBeenCalledTimes(1);
		const event = sink.mock.calls[0]?.[0] as ClientTelemetryEvent;
		expect(event).toMatchObject({
			type: "navigation",
			name: "web.navigation",
			path: "/new-page",
		});
		expect(event.durationMs).toBeGreaterThanOrEqual(120);
		expect(event.durationMs).toBeLessThan(60_000);
	});

	it("ignores onResolved without a preceding onBeforeNavigate", () => {
		const { router, handlers } = makeRouter();
		const sink = vi.fn<(event: ClientTelemetryEvent) => void>();
		instrumentRouter(router, sink);
		handlers.get("onResolved")?.({ type: "onResolved" });
		expect(sink).not.toHaveBeenCalled();
	});

	it("falls back to window.location when router.state is missing", () => {
		installBrowser();
		const handlers = new Map<string, (event: { type?: string }) => void>();
		const router = {
			subscribe: (_t: string, fn: (event: { type?: string }) => void) => {
				handlers.set(_t, fn);
				return () => {};
			},
		};
		const sink = vi.fn<(event: ClientTelemetryEvent) => void>();
		instrumentRouter(router, sink);
		handlers.get("onBeforeNavigate")?.({});
		handlers.get("onResolved")?.({});
		const event = sink.mock.calls[0]?.[0] as ClientTelemetryEvent;
		expect(event.path).toBe("/start");
	});

	it("uses the singleton telemetry instance when no sink is given", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const { router, handlers } = makeRouter();
		instrumentRouter(router);
		handlers.get("onBeforeNavigate")?.({});
		handlers.get("onResolved")?.({});
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.some((e) => e.name === "web.navigation")).toBe(true);
	});

	it("returns an unsubscribe that calls router unsubscribe fns", () => {
		const { router, unsubscribes } = makeRouter();
		const dispose = instrumentRouter(router, vi.fn<(event: ClientTelemetryEvent) => void>());
		expect(typeof dispose).toBe("function");
		dispose?.();
		expect(unsubscribes).toHaveBeenCalledTimes(2);
	});

	it("tolerates subscribe throwing and non-function returns", () => {
		const router = {
			subscribe: () => {
				throw new Error("no subscribe");
			},
			state: { location: { pathname: "/x" } },
		};
		const dispose = instrumentRouter(router, vi.fn<(event: ClientTelemetryEvent) => void>());
		expect(typeof dispose).toBe("function");
		expect(() => dispose?.()).not.toThrow();

		const voidRouter = { subscribe: () => undefined };
		const dispose2 = instrumentRouter(voidRouter, vi.fn<(event: ClientTelemetryEvent) => void>());
		expect(() => dispose2?.()).not.toThrow();
	});

	it("never throws when the sink throws", () => {
		const { router, handlers } = makeRouter();
		instrumentRouter(router, () => {
			throw new Error("sink boom");
		});
		handlers.get("onBeforeNavigate")?.({});
		expect(() => handlers.get("onResolved")?.({})).not.toThrow();
	});
});

describe("client telemetry edge coverage", () => {
	it("strips a path that reduces to empty after query removal", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "x", path: "?" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events[0]?.path).toBeUndefined();
		telemetry.dispose();
	});

	it("generates ids with Math.random fallbacks when crypto is absent", async () => {
		vi.stubGlobal("crypto", {});
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/x");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("x-request-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
	});

	it("handles URLs that fail URL parsing and empty stripped paths", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		// Invalid URL → catch path returns the query-stripped input.
		await (window.fetch as unknown as Mock)("http://[");
		// Empty origin → relative "?" cannot parse → stripped path "" → undefined.
		(browser.win.location as { origin: string }).origin = "";
		await (window.fetch as unknown as Mock)("?");
		await Promise.resolve();
	});

	it("stringifies exotic unhandledrejection reasons safely", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		browser.emitWindow("unhandledrejection", { reason: circular });
		browser.emitWindow("unhandledrejection", { reason: () => {} });
		const hostile = new Proxy(
			{},
			{
				get() {
					throw new Error("no props");
				},
			},
		);
		browser.emitWindow("unhandledrejection", { reason: hostile });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.length).toBeGreaterThanOrEqual(3);
	});

	it("drops the batch silently when neither beacon nor fetch can send", () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon = undefined as never;
		browser.win.fetch = undefined as never;
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "lost" });
		expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
		telemetry.dispose();
	});

	it("falls back to fetch when sendBeacon throws", async () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon.mockImplementation(() => {
			throw new Error("beacon boom");
		});
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "beacon-throw" });
		vi.advanceTimersByTime(5_000);
		const ingestCall = underlyingFetch().mock.calls.find((call) => call[0] === "/api/telemetry");
		expect(ingestCall).toBeDefined();
		await Promise.resolve();
		telemetry.dispose();
	});

	it("does not re-patch fetch when the patched flag is already set", () => {
		const browser = installBrowser();
		const originalFetch = browser.win.fetch;
		const store = globalThis as Record<symbol, unknown>;
		store[FETCH_PATCHED_KEY] = true;
		initClientTelemetry();
		// Flag set but fetch never wrapped — window.fetch stays original.
		expect(window.fetch).toBe(originalFetch);
	});

	it("merges init headers on Request-like inputs", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		const request = new Request("http://localhost/api/data", {
			headers: { "x-from-request": "1" },
		});
		await (window.fetch as unknown as Mock)(request, { headers: { "x-from-init": "2" } });
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("x-from-request")).toBe("1");
		expect(headers.get("x-from-init")).toBe("2");
		expect(headers.get("traceparent")).not.toBeNull();
	});

	it("dispose is idempotent", () => {
		installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.dispose();
		expect(() => telemetry.dispose()).not.toThrow();
	});
});

describe("client telemetry mutant kills", () => {
	it("defaults method to GET and preserves init.method for string inputs", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/a");
		await (window.fetch as unknown as Mock)("http://localhost/api/b", { method: "POST" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		const requests = events.filter((e) => e.name === "web.request");
		expect(requests.map((e) => e.attributes?.method)).toEqual(["GET", "POST"]);
	});

	it("skips instrumentation for absolute URLs matching the endpoint path", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		// url !== "/api/telemetry" but pathname === endpointPath — the
		// self-instrumentation guard must still skip it.
		await (window.fetch as unknown as Mock)("http://localhost/api/telemetry");
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		const [, init] = underlyingFetch().mock.calls[0] as [string, RequestInit | undefined];
		expect(init?.headers).toBeUndefined();
	});

	it("skips instrumentation when the request path cannot be resolved", async () => {
		const browser = installBrowser();
		(browser.win.location as { origin: string }).origin = "";
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("?");
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it("records a bounded durationMs for slow fetches", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		underlyingFetch().mockImplementation(
			() =>
				new Promise((resolve) => {
					setTimeout(() => resolve({ status: 200, ok: true }), 1_000);
				}),
		);
		const pending = (window.fetch as unknown as Mock)("http://localhost/api/slow");
		vi.advanceTimersByTime(1_000);
		await pending;
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event?.durationMs).toBeGreaterThanOrEqual(1_000);
		expect(event?.durationMs).toBeLessThan(60_000);
	});

	it("removes every listener on dispose", () => {
		const browser = installBrowser();
		const windowRemove = vi.fn<(...args: any[]) => void>();
		const documentRemove = vi.fn<(...args: any[]) => void>();
		const origWindowRemove = browser.win.removeEventListener;
		const origDocumentRemove = browser.doc.removeEventListener;
		browser.win.removeEventListener = ((type: string, fn: Listener) => {
			windowRemove(type, fn);
			origWindowRemove(type, fn);
		}) as never;
		browser.doc.removeEventListener = ((type: string, fn: Listener) => {
			documentRemove(type, fn);
			origDocumentRemove(type, fn);
		}) as never;
		const telemetry = initClientTelemetry();
		telemetry.dispose();
		for (const type of ["error", "unhandledrejection", "pagehide"]) {
			expect(windowRemove).toHaveBeenCalledWith(type, expect.any(Function));
		}
		expect(documentRemove).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
	});

	it("clears the flush interval on dispose", () => {
		installBrowser();
		const before = vi.getTimerCount();
		const telemetry = initClientTelemetry();
		expect(vi.getTimerCount()).toBe(before + 1);
		telemetry.dispose();
		expect(vi.getTimerCount()).toBe(before);
	});

	it("stays disposed — report() after dispose never flushes", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ maxBatchSize: 2 });
		telemetry.dispose();
		telemetry.report({ type: "event", name: "a" });
		telemetry.report({ type: "event", name: "b" });
		vi.advanceTimersByTime(10_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it("ignores dispose() on a stale instance after re-init", async () => {
		const browser = installBrowser();
		const first = initClientTelemetry();
		first.dispose();
		const second = initClientTelemetry();
		const wrappedFetch = window.fetch;
		first.dispose();
		expect(initClientTelemetry()).toBe(second);
		expect(window.fetch).toBe(wrappedFetch);
		await (window.fetch as unknown as Mock)("http://localhost/api/still-live");
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.some((e) => e.name === "web.request")).toBe(true);
		second.dispose();
	});

	it("keeps fetch patched when the stored original is missing", () => {
		installBrowser();
		initClientTelemetry();
		const wrapped = window.fetch;
		const store = globalThis as Record<symbol, unknown>;
		delete store[FETCH_ORIGINAL_KEY];
		const telemetry = store[GLOBAL_KEY] as { dispose: () => void };
		telemetry.dispose();
		expect(window.fetch).toBe(wrapped);
	});

	it("does not restore fetch when the patched flag was cleared externally", () => {
		installBrowser();
		initClientTelemetry();
		const wrapped = window.fetch;
		const original = underlyingFetch();
		(globalThis as Record<symbol, unknown>)[FETCH_PATCHED_KEY] = false;
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			dispose: () => void;
		};
		telemetry.dispose();
		expect(window.fetch).toBe(wrapped);
		expect(window.fetch).not.toBe(original);
	});
});

describe("instrumentRouter edge cases", () => {
	it("rejects non-object routers, including callables", () => {
		for (const bad of ["str", 42, true, undefined]) {
			expect(instrumentRouter(bad as never)).toBeUndefined();
		}
		const callable = Object.assign(() => {}, {
			subscribe: () => () => {},
		});
		expect(instrumentRouter(callable as never)).toBeUndefined();
	});

	it("falls back to window.location when router.state.location is missing", () => {
		installBrowser();
		const handlers = new Map<string, (event: { type?: string }) => void>();
		const router = {
			subscribe: (_t: string, fn: (event: { type?: string }) => void) => {
				handlers.set(_t, fn);
				return () => {};
			},
			state: {},
		};
		const sink = vi.fn<(event: ClientTelemetryEvent) => void>();
		instrumentRouter(router, sink);
		handlers.get("onBeforeNavigate")?.({});
		handlers.get("onResolved")?.({});
		expect(sink).toHaveBeenCalledTimes(1);
		const [event] = sink.mock.calls[0] as [ClientTelemetryEvent];
		expect(event.path).toBe("/start");
	});

	it("reports navigation with an undefined path when window.location is unavailable", () => {
		const browser = installBrowser();
		(browser.win as { location?: unknown }).location = undefined;
		const handlers = new Map<string, (event: { type?: string }) => void>();
		const router = {
			subscribe: (_t: string, fn: (event: { type?: string }) => void) => {
				handlers.set(_t, fn);
				return () => {};
			},
		};
		const sink = vi.fn<(event: ClientTelemetryEvent) => void>();
		instrumentRouter(router, sink);
		handlers.get("onBeforeNavigate")?.({});
		handlers.get("onResolved")?.({});
		expect(sink).toHaveBeenCalledTimes(1);
		const [event] = sink.mock.calls[0] as [ClientTelemetryEvent];
		expect(event.path).toBeUndefined();
	});
});

describe("instrumentRouter guards", () => {
	it("returns undefined when reading subscribe throws", () => {
		const hostile = {
			get subscribe(): never {
				throw new Error("getter boom");
			},
		};
		expect(instrumentRouter(hostile as never)).toBeUndefined();
	});
});

describe("client telemetry remaining branches", () => {
	it("uses 'Error' when an Error reason has an empty message", () => {
		const browser = installBrowser();
		initClientTelemetry();
		browser.emitWindow("unhandledrejection", { reason: new Error("") });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.at(-1)?.message).toBe("Error");
	});

	it("falls back to the raw endpoint when its path cannot be parsed", () => {
		const browser = installBrowser();
		(browser.win.location as { origin: string }).origin = "";
		initClientTelemetry({ endpoint: "?" });
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			report: (e: ClientTelemetryEvent) => void;
		};
		telemetry.report({ type: "event", name: "x" });
		vi.advanceTimersByTime(5_000);
		// Flush still targets the configured endpoint string.
		const sendBeacon = browser.win.navigator.sendBeacon;
		expect(sendBeacon).toHaveBeenCalled();
	});

	it("handles window error events without an Error payload or stack", () => {
		const browser = installBrowser();
		initClientTelemetry();
		browser.emitWindow("error", { message: "plain failure" });
		const noStack = new Error("nostack");
		noStack.stack = undefined;
		browser.emitWindow("error", { message: "m2", error: noStack });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.length).toBeGreaterThanOrEqual(2);
	});

	it("treats duck-typed request inputs without a method as GET", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)({ url: "http://localhost/duck" } as never);
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("traceparent")).not.toBeNull();
	});
});

describe("instrumentRouter SSR path", () => {
	it("reports navigation without a path when not in a browser", () => {
		const handlers = new Map<string, (e: { type?: string }) => void>();
		const router = {
			subscribe: (type: string, fn: (e: { type?: string }) => void) => {
				handlers.set(type, fn);
				return () => {};
			},
			state: { location: { pathname: "?" } },
		};
		const events: ClientTelemetryEvent[] = [];
		instrumentRouter(router, (e) => events.push(e));
		handlers.get("onBeforeNavigate")?.({});
		handlers.get("onResolved")?.({});
		expect(events).toHaveLength(1);
		expect(events[0]?.path).toBeUndefined();
	});
});

describe("client telemetry fetch rejection", () => {
	it("swallows ingest fetch rejections", async () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon.mockReturnValue(false);
		initClientTelemetry();
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			report: (e: ClientTelemetryEvent) => void;
			dispose: () => void;
		};
		telemetry.report({ type: "event", name: "will-fail" });
		underlyingFetch().mockRejectedValueOnce(new Error("network down"));
		vi.advanceTimersByTime(5_000);
		await Promise.resolve();
		await Promise.resolve();
		telemetry.dispose();
	});
});

describe("client telemetry mutation hardening", () => {
	it("returns a no-op when only window is defined (no document)", () => {
		installBrowser();
		vi.stubGlobal("document", undefined);
		const telemetry = initClientTelemetry();
		expect(() => telemetry.report({ type: "event", name: "x" })).not.toThrow();
		expect(() => telemetry.dispose()).not.toThrow();
	});

	it("returns a no-op when only document is defined (no window)", () => {
		installBrowser();
		vi.stubGlobal("window", undefined);
		const telemetry = initClientTelemetry();
		expect(() => telemetry.report({ type: "event", name: "x" })).not.toThrow();
		expect(() => telemetry.dispose()).not.toThrow();
	});

	it("initializes when window.location is unavailable", () => {
		const browser = installBrowser();
		(browser.win as { location?: unknown }).location = undefined;
		expect(() => initClientTelemetry()).not.toThrow();
	});

	it("records fetch calls whose URL fails URL parsing, with the stripped path", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://[");
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		const request = events.find((e) => e.type === "request");
		expect(request?.path).toBe("http://[");
	});

	it("does not record a request event when the stripped path is empty", async () => {
		const browser = installBrowser();
		(browser.win.location as { origin: string }).origin = "";
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("?");
		vi.advanceTimersByTime(10_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it("treats null and primitive fetch inputs as plain strings", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)(null as never);
		await (window.fetch as unknown as Mock)("http://localhost/plain");
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		const paths = events.filter((e) => e.type === "request").map((e) => e.path);
		expect(paths).toContain("/null");
		expect(paths).toContain("/plain");
	});

	it("requires a string url before treating fetch input as Request-like", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)({ url: 123 } as never);
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		const request = events.find((e) => e.type === "request");
		// Not request-like → String(input) is the URL.
		expect(request?.path).toBe("/[object%20Object]");
	});

	it("keeps sampling when sampleRate is NaN (non-finite → default 1)", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ sampleRate: Number.NaN });
		telemetry.report({ type: "event", name: "nan-rate" });
		vi.advanceTimersByTime(5_000);
		expect(beaconEvents(browser.win.navigator.sendBeacon)[0]?.name).toBe("nan-rate");
		telemetry.dispose();
	});

	it("honours fractional sample rates", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.4);
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ sampleRate: 0.5 });
		telemetry.report({ type: "event", name: "sampled-in" });
		vi.advanceTimersByTime(5_000);
		expect(beaconEvents(browser.win.navigator.sendBeacon)[0]?.name).toBe("sampled-in");
		telemetry.dispose();
	});

	it("flushes early at the default batch size of 20", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		for (let i = 0; i < 19; i++) {
			telemetry.report({ type: "event", name: `e${i}` });
		}
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.report({ type: "event", name: "e19" });
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("ignores a zero maxBatchSize", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({
			maxBatchSize: 0,
			flushIntervalMs: 60_000,
		});
		for (let i = 0; i < 25; i++) {
			telemetry.report({ type: "event", name: `e${i}` });
		}
		vi.advanceTimersByTime(1_000);
		// maxBatchSize 0 is invalid → default 20 → flushed once at 20 events.
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("ignores a negative maxBatchSize", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ maxBatchSize: -5 });
		telemetry.report({ type: "event", name: "one" });
		vi.advanceTimersByTime(1_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("ignores a string maxBatchSize", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({
			maxBatchSize: "5" as unknown as number,
			flushIntervalMs: 60_000,
		});
		for (let i = 0; i < 10; i++) {
			telemetry.report({ type: "event", name: `s${i}` });
		}
		vi.advanceTimersByTime(1_000);
		// "5" is not a number → default 20 → nothing flushed yet.
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("ignores a NaN maxBatchSize", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({
			maxBatchSize: Number.NaN,
			flushIntervalMs: 60_000,
		});
		for (let i = 0; i < 20; i++) {
			telemetry.report({ type: "event", name: `n${i}` });
		}
		// NaN fails the > 0 check → default 20 → flush at 20 events.
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("uses a custom flushIntervalMs", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ flushIntervalMs: 3_000 });
		telemetry.report({ type: "event", name: "timed" });
		vi.advanceTimersByTime(2_999);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("uses the default flush interval when flushIntervalMs is not positive", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ flushIntervalMs: 0 });
		telemetry.report({ type: "event", name: "zero-interval" });
		vi.advanceTimersByTime(4_999);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("uses the default flush interval when flushIntervalMs is NaN", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ flushIntervalMs: Number.NaN });
		telemetry.report({ type: "event", name: "nan-interval" });
		vi.advanceTimersByTime(1_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		vi.advanceTimersByTime(4_000);
		expect(browser.win.navigator.sendBeacon).toHaveBeenCalledTimes(1);
		telemetry.dispose();
	});

	it("uses the default flush interval when flushIntervalMs is a string", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry({
			flushIntervalMs: "100" as unknown as number,
		});
		telemetry.report({ type: "event", name: "string-interval" });
		vi.advanceTimersByTime(1_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("does not fall back to fetch when sendBeacon succeeds", () => {
		installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "beacon-only" });
		vi.advanceTimersByTime(5_000);
		// Beacon delivery → the fetch fallback must not also fire.
		expect(underlyingFetch()).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("sends content-type application/json on the fetch fallback", async () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon.mockReturnValue(false);
		initClientTelemetry();
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			report: (e: ClientTelemetryEvent) => void;
			dispose: () => void;
		};
		telemetry.report({ type: "event", name: "hdrs" });
		vi.advanceTimersByTime(5_000);
		const ingestCall = underlyingFetch().mock.calls.find((call) => call[0] === "/api/telemetry");
		const init = ingestCall?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(init.keepalive).toBe(true);
		expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
		await Promise.resolve();
		telemetry.dispose();
	});

	it("does not self-instrument the ingest endpoint for custom endpoints", () => {
		const browser = installBrowser();
		browser.win.navigator.sendBeacon.mockReturnValue(false);
		initClientTelemetry({ endpoint: "http://localhost:9999/ingest" });
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			report: (e: ClientTelemetryEvent) => void;
			dispose: () => void;
		};
		telemetry.report({ type: "event", name: "custom-endpoint" });
		vi.advanceTimersByTime(20_000);
		// Only the flush itself may hit fetch — no web.request self-events,
		// so the queue drains and later intervals send nothing.
		const ingestCalls = underlyingFetch().mock.calls.filter(
			(call) => call[0] === "http://localhost:9999/ingest",
		);
		expect(ingestCalls).toHaveLength(1);
		telemetry.dispose();
	});

	it("produces deterministic ids from crypto.getRandomValues/randomUUID", async () => {
		vi.stubGlobal("crypto", {
			getRandomValues: (buf: Uint8Array) => buf.fill(0xab),
			randomUUID: () => "11111111-2222-3333-4444-555555555555",
		});
		installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/x");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("x-request-id")).toBe("11111111-2222-3333-4444-555555555555");
		expect(headers.get("traceparent")).toBe(`00-${"ab".repeat(16)}-${"ab".repeat(8)}-01`);
	});

	it("falls back to template ids when crypto lacks randomUUID", async () => {
		vi.stubGlobal("crypto", {
			getRandomValues: (buf: Uint8Array) => buf.fill(0x01),
		});
		installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/y");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		// randomHex(4)-randomHex(2)-randomHex(2)-randomHex(2)-randomHex(6)
		expect(headers.get("x-request-id")).toBe("01010101-0101-0101-0101-010101010101");
	});

	it("generates hex ids via Math.random when crypto has no getRandomValues", async () => {
		vi.stubGlobal("crypto", {});
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/z");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		// floor(0.5 * 16) = 8 → every nibble is "8".
		expect(headers.get("traceparent")).toBe(`00-${"8".repeat(32)}-${"8".repeat(16)}-01`);
		expect(headers.get("x-request-id")).toBe("88888888-8888-8888-8888-888888888888");
	});

	it("still generates ids when crypto is entirely absent", async () => {
		vi.stubGlobal("crypto", undefined);
		installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://localhost/api/no-crypto");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("traceparent")).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
		expect(headers.get("x-request-id")).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it("drops null, primitive and incomplete report() inputs", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report(null as never);
		telemetry.report(undefined as never);
		telemetry.report(42 as never);
		telemetry.report("event" as never);
		telemetry.report({ type: "event" } as never);
		vi.advanceTimersByTime(10_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("clamps negative durations to zero and omits absent durations", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "neg-dur", durationMs: -50 });
		telemetry.report({ type: "event", name: "no-dur" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.find((e) => e.name === "neg-dur")?.durationMs).toBe(0);
		expect(events.find((e) => e.name === "no-dur")?.durationMs).toBeUndefined();
		telemetry.dispose();
	});

	it("reports unhandledrejection with stack for Error reasons", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const err = new Error("with-stack");
		browser.emitWindow("unhandledrejection", { reason: err });
		vi.advanceTimersByTime(5_000);
		const [event] = beaconEvents(browser.win.navigator.sendBeacon);
		expect(event).toMatchObject({ type: "error", name: "client.error" });
		expect(event?.stack).toBe(err.stack);
	});

	it("reports unhandledrejection for Errors without a stack", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const err = new Error("no-stack");
		err.stack = undefined;
		browser.emitWindow("unhandledrejection", { reason: err });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events).toHaveLength(1);
		expect(events[0]?.message).toBe("no-stack");
		expect(events[0]?.stack).toBeUndefined();
	});

	it("returns 'Unknown error' when both stringify paths fail", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const hostile = Object.create(null) as Record<string, unknown>;
		hostile.self = hostile;
		browser.emitWindow("unhandledrejection", { reason: hostile });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events[0]?.message).toBe("Unknown error");
	});

	it("still captures errors when window.location is unavailable", () => {
		const browser = installBrowser();
		initClientTelemetry();
		(browser.win as { location?: unknown }).location = undefined;
		browser.emitWindow("error", { message: "no-location" });
		browser.emitWindow("unhandledrejection", { reason: "rej-no-location" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events.filter((e) => e.type === "error")).toHaveLength(2);
		expect(events.every((e) => e.path === undefined)).toBe(true);
	});

	it("uses GET as the default method for Request-like fetch inputs", async () => {
		const browser = installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)({ url: "http://localhost/duck-get" } as never);
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		const request = events.find((e) => e.type === "request");
		expect(request?.attributes).toEqual({ method: "GET" });
	});

	it("omits the stack attribute for error events whose Error has no stack", () => {
		const browser = installBrowser();
		initClientTelemetry();
		const err = new Error("bare");
		err.stack = undefined;
		browser.emitWindow("error", { message: "bare", error: err });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events[0]?.stack).toBeUndefined();
	});

	it("drops events when Math.random() equals the sample rate", () => {
		vi.spyOn(Math, "random").mockReturnValue(0.5);
		const browser = installBrowser();
		const telemetry = initClientTelemetry({ sampleRate: 0.5 });
		telemetry.report({ type: "event", name: "boundary" });
		vi.advanceTimersByTime(10_000);
		// Sampling is strict `<`: random() === sampleRate is NOT kept.
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
		telemetry.dispose();
	});

	it("keeps attributes absent when neither serviceName nor attributes are set", () => {
		const browser = installBrowser();
		const telemetry = initClientTelemetry();
		telemetry.report({ type: "event", name: "no-attrs" });
		vi.advanceTimersByTime(5_000);
		const events = beaconEvents(browser.win.navigator.sendBeacon);
		expect(events[0]?.attributes).toBeUndefined();
		telemetry.dispose();
	});

	it("leaves window.fetch untouched when fetch is missing at init", () => {
		installBrowser();
		(window as { fetch?: unknown }).fetch = undefined;
		initClientTelemetry();
		expect(window.fetch).toBeUndefined();
	});

	it("injects no trace headers on requests whose URL cannot be parsed", async () => {
		installBrowser();
		initClientTelemetry();
		await (window.fetch as unknown as Mock)("http://[");
		const call = underlyingFetch().mock.calls.at(-1);
		const headers = new Headers((call?.[1] as RequestInit | undefined)?.headers);
		expect(headers.get("traceparent")).toBeNull();
		expect(headers.get("x-request-id")).toBeNull();
	});

	it("does not instrument fetches that resolve to the ingest endpoint path", async () => {
		const browser = installBrowser();
		initClientTelemetry({ endpoint: "http://localhost:9999/ingest" });
		// Same path as the endpoint but a different URL string — only the
		// pathname comparison can exclude it from instrumentation.
		await (window.fetch as unknown as Mock)("http://localhost:9999/ingest?x=1");
		vi.advanceTimersByTime(5_000);
		expect(browser.win.navigator.sendBeacon).not.toHaveBeenCalled();
	});

	it("falls back to fetch when window.navigator is unavailable", () => {
		const browser = installBrowser();
		(browser.win as { navigator?: unknown }).navigator = undefined;
		initClientTelemetry();
		const telemetry = (globalThis as Record<symbol, unknown>)[GLOBAL_KEY] as {
			report: (e: ClientTelemetryEvent) => void;
			dispose: () => void;
		};
		telemetry.report({ type: "event", name: "no-nav" });
		vi.advanceTimersByTime(5_000);
		const ingestCall = underlyingFetch().mock.calls.find((call) => call[0] === "/api/telemetry");
		expect(ingestCall).toBeDefined();
		telemetry.dispose();
	});
});
