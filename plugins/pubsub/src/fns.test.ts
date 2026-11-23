import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
	installServerFnRuntime,
	reactStartMock,
	reactStartServerMock,
	resetServerFnRuntime,
	serverFnRequestHeaders,
	sessionUser,
	stubAuth,
} from "@ktb/server-fns/testing";

vi.mock("@tanstack/react-start/server", () => reactStartServerMock());
vi.mock("@tanstack/react-start", () => reactStartMock());

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { Forbidden } from "@ktb/authz";

import { PubSubAdmin, type PubSubPublishResult } from "./admin.ts";
import { publishPubSubMessageFn } from "./fns.ts";

let currentEmail: string | null = "admin@x.com";
let publishResult: PubSubPublishResult = { ok: true };
let publishForbidden = false;
const publishCalls: [string, unknown][] = [];

const adminStub = PubSubAdmin.of({
	topics: () => Effect.succeed(null),
	declaredTopics: () => Effect.succeed(null),
	publish: (topicId, payload) => {
		publishCalls.push([topicId, payload]);
		return publishForbidden
			? Effect.fail(new Forbidden({ path: "platform.admin" }))
			: Effect.succeed(publishResult);
	},
});

const runtime = ManagedRuntime.make(Layer.succeed(PubSubAdmin, adminStub));

beforeAll(() => {
	installServerFnRuntime(
		runtime,
		stubAuth(() => sessionUser(currentEmail)),
	);
});

afterAll(async () => {
	resetServerFnRuntime();
	await runtime.dispose();
});

const useSession = (email: string | null) => {
	currentEmail = email;
	serverFnRequestHeaders.current =
		email === null ? new Headers() : new Headers({ cookie: `session=id-${email}` });
};

describe("publishPubSubMessageFn", () => {
	it("publishes a payload for admins", async () => {
		useSession("admin@x.com");
		publishResult = { ok: true };
		const res = await publishPubSubMessageFn({
			data: { topicId: "memory:cron.fires", payload: { ping: 1 } },
		});
		expect(res).toEqual({ ok: true });
		expect(publishCalls.at(-1)).toEqual(["memory:cron.fires", { ping: 1 }]);
	});

	it("propagates failure results", async () => {
		useSession("admin@x.com");
		publishResult = { ok: false, reason: "unknown-topic" };
		const res = await publishPubSubMessageFn({
			data: { topicId: "bogus", payload: null },
		});
		expect(res).toEqual({ ok: false, reason: "unknown-topic" });
	});

	it("collapses Forbidden to the forbidden result shape", async () => {
		useSession("admin@x.com");
		publishForbidden = true;
		const res = await publishPubSubMessageFn({ data: { topicId: "memory:x", payload: {} } });
		expect(res).toEqual({ ok: false, reason: "forbidden" });
		publishForbidden = false;
	});

	it("rejects anonymous sessions", async () => {
		useSession(null);
		await expect(
			publishPubSubMessageFn({ data: { topicId: "memory:x", payload: {} } }),
		).rejects.toThrow();
	});

	it("rejects an empty topic id at the schema boundary", async () => {
		useSession("admin@x.com");
		await expect(publishPubSubMessageFn({ data: { topicId: "", payload: {} } })).rejects.toThrow();
	});
});
