import { describe, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import { PluginStates } from "./plugin-states.ts";
import { ElementKinds } from "./element-kinds.ts";
import { PlatformAdmin } from "./index.ts";

describe("probe", () => {
  it("missing service error", async () => {
    for (const [n, s] of [["PluginStates", PluginStates],["ElementKinds", ElementKinds],["PlatformAdmin", PlatformAdmin]] as const) {
      const ex: any = await Effect.runPromiseExit(Effect.flatMap(s as any, (x:any)=>Effect.succeed(x)));
      console.log("SVC", n, "=>", Cause.pretty(ex.cause));
    }
  });
  it("issue tags", () => {
    const s = Schema.Struct({
      title: Schema.String,
      nested: Schema.optionalKey(Schema.Struct({ n: Schema.Number })),
      uni: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
      f: Schema.optionalKey(Schema.String.check(Schema.isMinLength(2))),
      enc: Schema.optionalKey(Schema.NumberFromString),
    });
    const r = Schema.decodeUnknownResult(s)({ title: 1, nested: {n:"x"}, uni: true, f: "a", enc: "zz" });
    console.log("ISSUE", JSON.stringify((r as any).failure?.issue ?? r, null, 1).slice(0, 6000));
  });
});
