import { describe, expect, it } from "vitest";

import { Principal } from "@ktb/authz";
import * as Effect from "effect/Effect";

import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	platformAdminPlugin,
	platformPanelPlugin,
	platformPortalPlugin,
	platformRoutesPlugin,
	plugins,
} from "./index.ts";

describe("parsePlatformAdminEmails", () => {
	it("parses a comma-separated list, normalized", () => {
		const emails = parsePlatformAdminEmails(" Admin@X.com , second@y.com ,,THIRD@z.com ");
		expect([...emails].sort()).toEqual(["admin@x.com", "second@y.com", "third@z.com"]);
	});

	it("returns an empty set for null/undefined/blank input", () => {
		expect(parsePlatformAdminEmails(null).size).toBe(0);
		expect(parsePlatformAdminEmails(undefined).size).toBe(0);
		expect(parsePlatformAdminEmails(" , ,").size).toBe(0);
	});
});

describe("makePlatformAdminGate", () => {
	const gate = makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"));

	it("isAdmin matches case/whitespace-insensitively", async () => {
		await expect(Effect.runPromise(gate.isAdmin(" Admin@X.com "))).resolves.toBe(true);
		await expect(Effect.runPromise(gate.isAdmin("other@x.com"))).resolves.toBe(false);
		await expect(Effect.runPromise(gate.isAdmin(null))).resolves.toBe(false);
		await expect(Effect.runPromise(gate.isAdmin(undefined))).resolves.toBe(false);
	});

	it("requireAdmin passes for an allowlisted principal email", async () => {
		const effect = gate
			.requireAdmin()
			.pipe(Effect.provideService(Principal, { userId: "u1", email: "Admin@X.com" }));
		await expect(Effect.runPromise(effect)).resolves.toBeUndefined();
	});

	it("requireAdmin fails Forbidden for non-admin, missing email and null principal", async () => {
		const as = (principal: { userId: string; email?: string } | null) =>
			gate.requireAdmin().pipe(Effect.provideService(Principal, principal));
		await expect(
			Effect.runPromise(as({ userId: "u1", email: "other@x.com" })),
		).rejects.toMatchObject({ _tag: "Forbidden", path: "platform.admin" });
		await expect(Effect.runPromise(as({ userId: "u1" }))).rejects.toMatchObject({
			_tag: "Forbidden",
		});
		await expect(Effect.runPromise(as(null))).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("empty allowlist denies everyone", async () => {
		const empty = makePlatformAdminGate(parsePlatformAdminEmails(undefined));
		await expect(Effect.runPromise(empty.isAdmin("admin@x.com"))).resolves.toBe(false);
		const effect = empty
			.requireAdmin()
			.pipe(Effect.provideService(Principal, { userId: "u1", email: "admin@x.com" }));
		await expect(Effect.runPromise(effect)).rejects.toMatchObject({ _tag: "Forbidden" });
	});

	it("grantFor admits a subject whose userId holds the grant", async () => {
		const seen: string[] = [];
		const rbacGate = makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"), {
			grantFor: (userId) => {
				seen.push(userId);
				return Effect.succeed(userId === "root");
			},
		});
		// Bare-email subjects carry no userId — grantFor is never consulted.
		await expect(Effect.runPromise(rbacGate.isAdmin("other@x.com"))).resolves.toBe(false);
		await expect(Effect.runPromise(rbacGate.isAdmin({ userId: "root" }))).resolves.toBe(true);
		await expect(
			Effect.runPromise(rbacGate.isAdmin({ email: "other@x.com", userId: "root" })),
		).resolves.toBe(true);
		await expect(Effect.runPromise(rbacGate.isAdmin({ userId: "u2" }))).resolves.toBe(false);
		expect(seen).toEqual(["root", "root", "u2"]);
	});

	it("requireAdmin passes via grantFor and prefers actorId under delegation", async () => {
		const seen: string[] = [];
		const rbacGate = makePlatformAdminGate(new Set(), {
			grantFor: (userId) => {
				seen.push(userId);
				return Effect.succeed(userId === "account-1");
			},
		});
		const delegated = rbacGate.requireAdmin().pipe(
			Effect.provideService(Principal, {
				userId: "doctor-1",
				actorId: "account-1",
				email: "doc@x.com",
			}),
		);
		await expect(Effect.runPromise(delegated)).resolves.toBeUndefined();
		expect(seen).toEqual(["account-1"]);
	});
});

describe("plugins", () => {
	it("declares the gate marker, routes dep anchor and panel plugins — all system", () => {
		expect(platformAdminPlugin.id).toBe("platform.admin");
		expect(platformAdminPlugin.system).toBe(true);
		expect(platformRoutesPlugin.id).toBe("platform.routes");
		expect(platformRoutesPlugin.system).toBe(true);
		// Route collapse: the /platform* subtree dispatches through the
		// host's root `/$` splat — the plugin is a dep anchor only.
		expect("routes" in platformRoutesPlugin).toBe(false);
		expect(platformPanelPlugin.id).toBe("platform.panel");
		expect(platformPanelPlugin.system).toBe(true);
		expect(platformPanelPlugin.requiredDeps).toEqual(["platform.routes"]);
		expect("panel" in platformPanelPlugin).toBe(false);
	});

	it("declares the platform portal instance — system, admin audience", () => {
		expect(platformPortalPlugin.id).toBe("platform.portal");
		expect(platformPortalPlugin.system).toBe(true);
		expect(platformPortalPlugin.requiredDeps).toEqual(["platform.panel"]);
		expect(platformPortalPlugin.portals).toEqual([
			{
				id: "platform",
				basePath: "/platform",
				label: "Platform",
				audience: "platform-admin",
			},
		]);
	});

	it("exports the discovery plugins array", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"platform.admin",
			"platform.routes",
			"platform.panel",
			"platform.portal",
		]);
	});
});
