/**
 * @ktb/queues-port/testing — the shared `QueueTransport` contract
 * suite. Adapter packages run `queueTransportContract` against their
 * transport so every implementation is held to the same send /
 * receive / stats / close semantics (the repo's analogue of a
 * port-contract test — see @ktb/db-testing for the DB-side double
 * pattern).
 *
 * Test-only subpath: never import this from runtime code — it pulls
 * in vitest.
 */

import { describe, expect, it } from "vitest";

import type { QueueTransport } from "./index.ts";

export interface QueueTransportContractSpec {
	/** Suite label — the adapter under test (e.g. "redis", "sqlite"). */
	readonly name: string;
	/** Factory producing a fresh, isolated transport per case — tests
	 * must not share broker state. Configure short block/idle timeouts
	 * here so empty-`receive` cases stay fast. */
	readonly make: () => Promise<QueueTransport> | QueueTransport;
	/** Set false for push-delivered transports with no `receive` pull
	 * surface (Cloudflare Queue bindings deliver batches to the worker
	 * entry's `queue` handler). Default true. */
	readonly pull?: boolean;
}

const close = async (transport: QueueTransport): Promise<void> => {
	await transport.close?.();
};

/**
 * Register the contract cases for one adapter. Cases that need a pull
 * surface or a stats probe self-skip when the transport lacks them —
 * the suite still asserts send + close for every conforming transport.
 */
export const queueTransportContract = (spec: QueueTransportContractSpec): void => {
	const pull = spec.pull !== false;
	describe(`QueueTransport contract — ${spec.name}`, () => {
		it("send() accepts a body and resolves", async () => {
			const transport = await spec.make();
			await transport.send({ contract: spec.name });
			await close(transport);
		});

		it("stats() — when the transport probes — counts the sent message", async () => {
			const transport = await spec.make();
			const stats = transport.stats;
			if (stats === undefined) return; // no query surface — honest null upstream
			await transport.send({ contract: spec.name });
			const depth = await stats.call(transport);
			expect(depth).not.toBeNull();
			/* v8 ignore next -- the assertion above makes null unreachable;
			   the guard only narrows the type for the count check */
			if (depth === null) return;
			expect(depth.pending + depth.processing).toBeGreaterThanOrEqual(1);
			await close(transport);
		});

		if (pull) {
			it("receive() returns the sent body as an ack-able message", async () => {
				const transport = await spec.make();
				const receive = transport.receive;
				// Contract enforcement: a pull spec without receive() fails
				// here rather than skipping silently.
				expect(receive, `${spec.name}: expected a receive() surface`).toBeDefined();
				await transport.send({ hello: "contract" });
				const messages = await receive!.call(transport, 1);
				expect(messages.length).toBeGreaterThanOrEqual(1);
				expect(messages[0]).toMatchObject({ body: { hello: "contract" } });
				messages[0]!.ack();
				await close(transport);
			});

			it("receive() resolves an empty batch when nothing is queued", async () => {
				const transport = await spec.make();
				const receive = transport.receive;
				expect(receive, `${spec.name}: expected a receive() surface`).toBeDefined();
				expect(await receive!.call(transport, 1)).toEqual([]);
				await close(transport);
			});
		}

		it("close() releases resources when present", async () => {
			const transport = await spec.make();
			await close(transport);
		});
	});
};
