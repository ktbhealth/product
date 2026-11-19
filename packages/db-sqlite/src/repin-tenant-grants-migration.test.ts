import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";

import { applyMigrations } from "./migrate.ts";

// T-188: strict tenantPolicy hides tenant_id NULL tuples, so 0064
// mirrors every global role grant (object_id '*', subject_kind 'role')
// onto each tenant the role has a tenant-pinned member tuple in. This
// runs the real migration files over a database holding pre-0064 data.

const MIGRATIONS = fileURLToPath(new URL("../../db/drizzle", import.meta.url));
const FIRST_NEW = "0064_repin_tenant_grants.sql";

const tuple = (
	objectType: string,
	objectId: string,
	relation: string,
	subjectKind: string,
	subjectId: string,
	tenantId: string | null,
) =>
	`INSERT INTO relation_tuples (object_type, object_id, relation, subject_kind, subject_id, effect, tenant_id, expires_at, granted_by, created_at) ` +
	`VALUES ('${objectType}', '${objectId}', '${relation}', '${subjectKind}', '${subjectId}', 'allow', ${tenantId === null ? "NULL" : `'${tenantId}'`}, NULL, NULL, 0)`;

describe("repin tenant grants migration (T-188)", () => {
	const dir = mkdtempSync(join(tmpdir(), "ktb-repin-grants-"));
	const sqlite = new Database(":memory:");
	const files = readdirSync(MIGRATIONS)
		.filter((f) => f.endsWith(".sql"))
		.sort();
	const stage = (wanted: (name: string) => boolean) => {
		for (const name of files.filter(wanted)) copyFileSync(join(MIGRATIONS, name), join(dir, name));
	};

	afterAll(() => {
		sqlite.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const grantsOf = (subjectId: string, tenantId: string | null) =>
		sqlite
			.prepare(
				`SELECT object_type, relation, effect, tenant_id FROM relation_tuples ` +
					`WHERE object_id = '*' AND subject_kind = 'role' AND subject_id = ? ` +
					`AND ${tenantId === null ? "tenant_id IS NULL" : "tenant_id = ?"} ORDER BY object_type, relation`,
			)
			.all(...(tenantId === null ? [subjectId] : [subjectId, tenantId])) as {
			object_type: string;
			relation: string;
			effect: string;
			tenant_id: string | null;
		}[];

	it("pins global role grants to member tenants only", () => {
		// Schema as it was before T-188.
		stage((name) => name < FIRST_NEW);
		applyMigrations(sqlite, dir);

		// Pre-0064 data: global grants + mixed-scope memberships.
		sqlite.exec(
			[
				// auditor: tenant-pinned member in '7' AND a global member.
				tuple("role", "auditor", "member", "user", "u1", "7"),
				tuple("role", "auditor", "member", "user", "u2", null),
				tuple("audit", "*", "read", "role", "auditor", null),
				tuple("patient", "*", "read", "role", "auditor", null),
				// clerk: only a GLOBAL member — its grants must not pin.
				tuple("role", "clerk", "member", "user", "u3", null),
				tuple("billing", "*", "manage", "role", "clerk", null),
				// nurse: tenant members in TWO tenants.
				tuple("role", "nurse", "member", "user", "u4", "7"),
				tuple("role", "nurse", "member", "group", "g9", "clinic-b"),
				tuple("consultation", "*", "read", "role", "nurse", null),
				// Non-catalog tuples are out of scope: a direct user grant
				// and an entity-level owner tuple never pin.
				tuple("patient", "*", "delete", "user", "u9", null),
				tuple("patient", "42", "owner", "user", "u1", null),
				// A mirror that already exists must not duplicate.
				tuple("audit", "*", "read", "role", "auditor", "7"),
			].join(";"),
		);

		// The new migration, applied on top.
		stage((name) => name >= FIRST_NEW);
		expect(applyMigrations(sqlite, dir)).toEqual(files.filter((name) => name >= FIRST_NEW));

		// auditor's two catalog grants pinned to '7' exactly once each
		// (the pre-existing audit.read mirror absorbed the NOT EXISTS).
		expect(grantsOf("auditor", "7")).toEqual([
			{ object_type: "audit", relation: "read", effect: "allow", tenant_id: "7" },
			{ object_type: "patient", relation: "read", effect: "allow", tenant_id: "7" },
		]);
		// …and nowhere else: the global member does not create scope.
		expect(grantsOf("auditor", "clinic-b")).toEqual([]);
		// clerk has no tenant-pinned member → nothing pinned.
		expect(grantsOf("clerk", "7")).toEqual([]);
		// nurse pins to both member tenants.
		expect(grantsOf("nurse", "7")).toEqual([
			{ object_type: "consultation", relation: "read", effect: "allow", tenant_id: "7" },
		]);
		expect(grantsOf("nurse", "clinic-b")).toEqual([
			{ object_type: "consultation", relation: "read", effect: "allow", tenant_id: "clinic-b" },
		]);
		// Global grants remain untouched.
		expect(grantsOf("auditor", null)).toHaveLength(2);
		// The direct user grant and entity owner tuple got no copies.
		const stray = sqlite
			.prepare(
				`SELECT COUNT(*) AS n FROM relation_tuples WHERE tenant_id = '7' ` +
					`AND (subject_id = 'u9' OR object_id = '42')`,
			)
			.get() as { n: number };
		expect(stray.n).toBe(0);
	});
});
