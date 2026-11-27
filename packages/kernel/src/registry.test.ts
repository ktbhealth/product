import { describe, expect, it } from "vitest";

import { makeRegistry } from "./registry.ts";

class DuplicateThing extends Error {
	readonly _tag = "DuplicateThing";
	constructor(readonly id: string) {
		super(`duplicate ${id}`);
	}
}

class UnknownThing extends Error {
	readonly _tag = "UnknownThing";
	constructor(readonly id: string) {
		super(`unknown ${id}`);
	}
}

const make = () =>
	makeRegistry<{ id: string; n: number }>({
		key: (e) => e.id,
		duplicate: (id) => new DuplicateThing(id),
		unknown: (id) => new UnknownThing(id),
	});

describe("makeRegistry", () => {
	it("register/get/has/list round-trip in registration order", () => {
		const r = make();
		r.register({ id: "b", n: 2 });
		r.register({ id: "a", n: 1 });
		expect(r.get("b")).toEqual({ id: "b", n: 2 });
		expect(r.has("a")).toBe(true);
		expect(r.has("z")).toBe(false);
		expect(r.list()).toEqual([
			{ id: "b", n: 2 },
			{ id: "a", n: 1 },
		]);
	});

	it("register throws the duplicate factory error on a taken key", () => {
		const r = make();
		r.register({ id: "x", n: 1 });
		expect(() => r.register({ id: "x", n: 2 })).toThrowError(DuplicateThing);
		expect(r.get("x")).toEqual({ id: "x", n: 1 });
	});

	it("get throws the unknown factory error when absent", () => {
		const r = make();
		expect(() => r.get("nope")).toThrowError(UnknownThing);
	});

	it("lookup returns undefined instead of throwing", () => {
		const r = make();
		expect(r.lookup("nope")).toBeUndefined();
		r.register({ id: "k", n: 0 });
		expect(r.lookup("k")).toEqual({ id: "k", n: 0 });
	});

	it("validate runs after the duplicate check and before insert", () => {
		const order: string[] = [];
		const r = makeRegistry<{ id: string }>({
			key: (e) => e.id,
			duplicate: (id) => new DuplicateThing(id),
			validate: () => {
				order.push("validate");
			},
		});
		r.register({ id: "a" });
		expect(order).toEqual(["validate"]);
		expect(() => r.register({ id: "a" })).toThrowError(DuplicateThing);
		expect(order).toEqual(["validate"]);
	});

	it("falls back to plain Errors without factories", () => {
		const r = makeRegistry<{ id: string }>({ key: (e) => e.id });
		r.register({ id: "a" });
		expect(() => r.register({ id: "a" })).toThrowError(/duplicate registry entry "a"/);
		expect(() => r.get("b")).toThrowError(/unknown registry entry "b"/);
	});
});
