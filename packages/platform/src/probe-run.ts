import * as Schema from "effect/Schema";

const tags = (issue: any): any => {
  if (issue == null || typeof issue !== "object") return issue;
  const out: any = { _tag: issue._tag, path: issue.path };
  if (issue.issue) out.issue = tags(issue.issue);
  if (issue.issues) out.issues = issue.issues.map(tags);
  return out;
};
const dec = (name: string, schema: any, input: any) => {
  const r: any = Schema.decodeUnknownResult(schema)(input);
  console.log(name, "=>", JSON.stringify(r.failure ? tags(r.failure.issue) : r.success));
};

dec("pointer-nested", Schema.Struct({ a: Schema.Struct({ b: Schema.Number }) }), { a: { b: "x" } });
dec("anyof", Schema.Struct({ u: Schema.Union([Schema.String, Schema.Number]) }), { u: true });
dec("filter", Schema.Struct({ f: Schema.String.check(Schema.isMinLength(2)) }), { f: "a" });
dec("encoding", Schema.Struct({ e: Schema.NumberFromString }), { e: "zz" });
dec("composite", Schema.Struct({ t: Schema.String }), { t: 1 });
dec("literal", Schema.Literal("a","b"), "c");
