import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";

import {
	isEmptySelector,
	makeTenantResolver,
	TENANT_SELECTOR_HEADERS,
	TenantNotFound,
	TenantRequired,
	tenantSelectorFromHeaders,
	type TenantDirectoryShape,
	type TenantMembership,
	type TenantSelector,
} from "./index.ts";

/**
 * Property-style fuzz for the tenant selector transport (P-053).
 *
 * `tenantSelectorFromHeaders` is pure — random header combinations
 * (missing, malformed, conflicting, duplicate) must always produce a
 * selector that faithfully mirrors the headers: `null` iff no tenant
 * header is present, numeric `id` iff the raw value matches the
 * integer shape, and every populated field traceable to a header.
 *
 * The resolver fuzz then feeds those selectors (plus direct selector
 * objects) through `makeTenantResolver` backed by a membership-scoped
 * directory — the same contract real directories implement — and
 * asserts the resolved tenant is always `null` (personal/fallback) or
 * a tenant the principal actually belongs to; anything else must fail
 * `TenantNotFound`/`TenantRequired`, never silently resolve foreign.
 *
 * Same determinism story as `scoped-repo.property.test.ts`: mulberry32
 * seeds, no property-testing dependency.
 */

/** mulberry32 — identical to the scoped-repo fuzz (kept local: test
 * files must not share helpers across modules). */
const mulberry32 = (seed: number): (() => number) => {
	let a = seed | 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
};

type Rng = () => number;

const int = (rng: Rng, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = <T>(rng: Rng, values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;
const chance = (rng: Rng, p: number) => rng() < p;

const HEADER_NAMES = [
	TENANT_SELECTOR_HEADERS.id,
	TENANT_SELECTOR_HEADERS.slug,
	TENANT_SELECTOR_HEADERS.kind,
	TENANT_SELECTOR_HEADERS.raw,
] as const;

/** Adversarial header values: empty, whitespace, pseudo-numerics,
 * unicode digits, lists, markup, huge strings. */
const HEADER_VALUES = [
	"",
	" ",
	"  42  ",
	"0",
	"-0",
	"00",
	"+12",
	"1e3",
	"0x10",
	"1.5",
	"NaN",
	"Infinity",
	// NOTE: Headers requires ByteString values — non-Latin-1 input
	// (e.g. "٤٢") is rejected by the transport itself, so it cannot
	// reach the selector through this path.
	"abc",
	"clinic-a",
	"clinic-a, clinic-b",
	"<script>alert(1)</script>",
	"null",
	"undefined",
	"a".repeat(500),
] as const;

const genHeaders = (rng: Rng): Headers => {
	const headers = new Headers();
	for (const name of HEADER_NAMES) {
		if (!chance(rng, 0.45)) continue;
		const value = pick(rng, HEADER_VALUES);
		headers.set(name, value);
		// Duplicate/conflicting values sometimes — Headers merges them.
		if (chance(rng, 0.15)) headers.append(name, pick(rng, HEADER_VALUES));
	}
	return headers;
};

const FIELD_FOR_HEADER: Record<string, "id" | "slug" | "kind" | "raw"> = {
	[TENANT_SELECTOR_HEADERS.id]: "id",
	[TENANT_SELECTOR_HEADERS.slug]: "slug",
	[TENANT_SELECTOR_HEADERS.kind]: "kind",
	[TENANT_SELECTOR_HEADERS.raw]: "raw",
};

describe("tenantSelectorFromHeaders (property fuzz)", () => {
	it("always mirrors the headers exactly", () => {
		const rng = mulberry32(0xf00dfeed);
		const failures: string[] = [];
		const check = (ok: boolean, msg: string) => {
			if (!ok) failures.push(msg);
		};
		for (let i = 0; i < 2_000; i++) {
			const headers = genHeaders(rng);
			const tag = `iteration=${i} headers=${JSON.stringify([...headers.entries()])}`;
			const selector = tenantSelectorFromHeaders(headers);
			const present = HEADER_NAMES.filter((name) => headers.get(name) !== null);

			if (present.length === 0) {
				check(selector === null, `${tag}: expected null selector`);
				continue;
			}
			if (selector === null) {
				failures.push(`${tag}: expected a selector`);
				continue;
			}
			const s = selector;
			const expectedKeys = present.map((name) => FIELD_FOR_HEADER[name]).sort();
			check(
				JSON.stringify(Object.keys(s).sort()) === JSON.stringify(expectedKeys),
				`${tag}: keys ${JSON.stringify(Object.keys(s))} != ${JSON.stringify(expectedKeys)}`,
			);

			for (const name of present) {
				const field = FIELD_FOR_HEADER[name];
				const raw = headers.get(name)!;
				if (field === "id") {
					if (/^-?\d+$/.test(raw)) {
						check(typeof s.id === "number" && s.id === Number(raw), `${tag}: id=${String(s.id)}`);
					} else {
						check(s.id === raw, `${tag}: id=${String(s.id)} != ${raw}`);
					}
				} else {
					check(s[field] === raw, `${tag}: ${field}=${String(s[field])} != ${raw}`);
				}
			}
			// Any populated header makes the selector non-empty — the
			// resolver's empty-selector fast path must never trigger on
			// a real (even malformed) tenant signal.
			check(!isEmptySelector(s), `${tag}: selector unexpectedly empty`);
		}
		expect(failures).toEqual([]);
	}, 30_000);
});

// ---------- resolver fuzz ----------

const TENANTS = [
	{ id: 1, kind: "clinic", slug: "clinic-a" },
	{ id: 2, kind: "clinic", slug: "clinic-b" },
	{ id: 3, kind: "lab", slug: "lab-c" },
] as const;

const MEMBERSHIPS: readonly TenantMembership[] = TENANTS.map((t, i) => ({
	tenant: t,
	role: (["owner", "admin", "member"] as const)[i]!,
}));

/** A directory implementing the membership-scoped contract: selectors
 * naming tenants outside the principal's memberships resolve `null`,
 * exactly like a real adapter must. Matching mirrors slug, numeric id,
 * or raw slug — any broader match would be an adapter bug, not a
 * resolver one. */
const membershipDirectory = (): TenantDirectoryShape => ({
	membershipsFor: () => Effect.succeed(MEMBERSHIPS),
	findBySelector: (_userId, selector) =>
		Effect.succeed(
			MEMBERSHIPS.map((m) => ({ ...m.tenant, role: m.role })).find(
				(t) =>
					(selector.slug !== undefined && selector.slug === t.slug) ||
					(typeof selector.id === "number" && selector.id === Number(t.id)) ||
					selector.raw === t.slug,
			) ?? null,
		),
});

const MEMBER_IDS = new Set<number>(TENANTS.map((t) => t.id));

const genSelector = (rng: Rng): TenantSelector | null => {
	const roll = int(rng, 0, 10);
	if (roll === 0) return null;
	if (roll === 1) return {};
	const selector: {
		id?: string | number;
		slug?: string;
		kind?: string;
		raw?: unknown;
	} = {};
	if (chance(rng, 0.5)) {
		// Mix member and foreign ids — foreign ones must never resolve.
		const foreign = int(rng, 100, 999);
		selector.id = chance(rng, 0.6) ? pick(rng, [...MEMBER_IDS]) : foreign;
	}
	if (chance(rng, 0.5)) selector.slug = pick(rng, ["clinic-a", "clinic-b", "lab-c", "foreign", ""]);
	if (chance(rng, 0.3)) selector.kind = pick(rng, ["clinic", "lab", "bogus"]);
	if (chance(rng, 0.3)) selector.raw = pick(rng, ["clinic-a", "foreign", 42, null]);
	return selector;
};

describe("makeTenantResolver (property fuzz)", () => {
	it("only ever resolves null or a tenant the principal belongs to", async () => {
		const rng = mulberry32(0xbad5eed);
		const failures: string[] = [];
		let resolved = 0;
		for (let i = 0; i < 500; i++) {
			const selector = genSelector(rng);
			const userId = chance(rng, 0.15) ? null : `user-${int(rng, 1, 5)}`;
			const fallback = chance(rng, 0.5) ? ("personal" as const) : ("deny" as const);
			const selectDefault = chance(rng, 0.5)
				? (ms: readonly TenantMembership[]) => (chance(rng, 0.7) ? (ms[0] ?? null) : null)
				: undefined;
			const resolver = makeTenantResolver({
				directory: membershipDirectory(),
				fallback,
				...(selectDefault === undefined ? {} : { selectDefault }),
			});
			const tag = `iteration=${i} selector=${JSON.stringify(selector)} user=${userId}`;
			try {
				const tenant = await Effect.runPromise(resolver.resolve(selector, userId));
				if (tenant !== null) {
					resolved++;
					if (!MEMBER_IDS.has(Number(tenant.id))) {
						failures.push(`${tag}: resolved foreign tenant ${JSON.stringify(tenant)}`);
					}
				}
			} catch (err) {
				if (!(err instanceof TenantNotFound || err instanceof TenantRequired)) {
					failures.push(`${tag}: unexpected failure ${String(err)}`);
				}
			}
		}
		// The fuzz must actually exercise resolution, not just fallbacks.
		expect(resolved).toBeGreaterThan(0);
		expect(failures).toEqual([]);
	}, 30_000);
});
