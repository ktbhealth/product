import { describe, expect, expectTypeOf, it } from "vitest";

import { f, type InferField, type InferInsert, type InferRecord } from "./fields.ts";

describe("field builders", () => {
	it("produces kind-tagged descriptors with options", () => {
		expect(f.string({ required: true, maxLength: 10 })).toEqual({
			kind: "string",
			required: true,
			maxLength: 10,
		});
		expect(f.number({ min: 1, max: 5 })).toEqual({ kind: "number", min: 1, max: 5 });
		expect(f.boolean()).toEqual({ kind: "boolean" });
		expect(f.date()).toEqual({ kind: "date" });
		expect(f.json({ default: null })).toEqual({ kind: "json", default: null });
		expect(f.enum(["x", "y"])).toEqual({ kind: "enum", values: ["x", "y"] });
		expect(f.array(f.string(), { minLength: 2 })).toEqual({
			kind: "array",
			of: { kind: "string" },
			minLength: 2,
		});
		expect(f.ref({ collection: "c" })).toEqual({
			kind: "ref",
			collection: "c",
			onDelete: "restrict",
		});
		expect(f.ref({ collection: "c", onDelete: "cascade" })).toEqual({
			kind: "ref",
			collection: "c",
			onDelete: "cascade",
		});
	});
});

describe("InferField / InferInsert / InferRecord", () => {
	const fields = {
		title: f.string({ required: true }),
		count: f.number({ default: 0 }),
		kind: f.enum(["a", "b"] as const),
		tags: f.array(f.number()),
		meta: f.json(),
		when: f.date(),
		flag: f.boolean(),
		link: f.ref({ collection: "other" }),
	};

	it("maps descriptor kinds to value types", () => {
		expectTypeOf<InferField<typeof fields.title>>().toEqualTypeOf<string>();
		expectTypeOf<InferField<typeof fields.count>>().toEqualTypeOf<number>();
		expectTypeOf<InferField<typeof fields.kind>>().toEqualTypeOf<"a" | "b">();
		expectTypeOf<InferField<typeof fields.tags>>().toEqualTypeOf<number[]>();
		expectTypeOf<InferField<typeof fields.when>>().toEqualTypeOf<number>();
		expectTypeOf<InferField<typeof fields.flag>>().toEqualTypeOf<boolean>();
		expectTypeOf<InferField<typeof fields.link>>().toEqualTypeOf<number | null>();
		expectTypeOf<InferField<typeof fields.meta>>().toEqualTypeOf<unknown>();
	});

	it("InferInsert requires required keys and allows the rest to be omitted", () => {
		type Ins = InferInsert<typeof fields>;
		expectTypeOf<Ins["title"]>().toEqualTypeOf<string>();
		expectTypeOf<Ins["count"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Ins["kind"]>().toEqualTypeOf<"a" | "b" | undefined>();
		expectTypeOf<Ins["tags"]>().toEqualTypeOf<number[] | undefined>();
		expectTypeOf<Ins["meta"]>().toEqualTypeOf<unknown>();
		expectTypeOf<Ins["when"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Ins["flag"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<Ins["link"]>().toEqualTypeOf<number | null | undefined>();
		// `title` is the only required key: a shape without it is not
		// assignable to Ins.
		expectTypeOf<{ count: number }>().not.toMatchTypeOf<Ins>();
		expectTypeOf<{ title: string }>().toMatchTypeOf<Ins>();
	});

	it("InferRecord keeps every key, undefined-able unless required", () => {
		type Rec = InferRecord<typeof fields>;
		expectTypeOf<Rec["title"]>().toEqualTypeOf<string>();
		expectTypeOf<Rec["count"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Rec["kind"]>().toEqualTypeOf<"a" | "b" | undefined>();
		expectTypeOf<Rec["tags"]>().toEqualTypeOf<number[] | undefined>();
		expectTypeOf<Rec["meta"]>().toEqualTypeOf<unknown>();
		expectTypeOf<Rec["when"]>().toEqualTypeOf<number | undefined>();
		expectTypeOf<Rec["flag"]>().toEqualTypeOf<boolean | undefined>();
		expectTypeOf<Rec["link"]>().toEqualTypeOf<number | null | undefined>();
	});

	it("required ref fields admit null but not undefined", () => {
		const withReq = { ...fields, req: f.ref({ collection: "x" }, { required: true }) };
		type Ins = InferInsert<typeof withReq>;
		type Rec = InferRecord<typeof withReq>;
		expectTypeOf<Ins["req"]>().toEqualTypeOf<number | null>();
		expectTypeOf<Rec["req"]>().toEqualTypeOf<number | null>();
	});
});
