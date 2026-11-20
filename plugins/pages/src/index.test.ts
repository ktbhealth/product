import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Db, makeDb } from "@ktb/db";
import { makeD1 } from "@ktb/db/testing";
import { Forbidden, Principal } from "@ktb/authz";
import {
	makePlatformAdminGate,
	parsePlatformAdminEmails,
	PlatformAdmin,
	platformAdminPlugin,
} from "@ktb/platform";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";

import {
	pagesChromePlugin,
	pagesPanelPlugin,
	pagesRenderPlugin,
	pagesServicesPlugin,
	pagesTablesPlugin,
	plugins,
} from "./index.ts";
import { RichTexts } from "@ktb/rich-text/service";
import { richTextServicesPlugin } from "@ktb/rich-text";
import { Schemas } from "@ktb/schemas/service";
import { schemasServicesPlugin } from "@ktb/schemas";
import { Layouts } from "@ktb/layouts/service";
import { layoutsServicesPlugin } from "@ktb/layouts";

import { page } from "./schema.ts";
import { PAGES_TEST_DDL, PagesLive } from "./service.ts";

describe("pages plugins", () => {
	it("exposes the five single-concern plugins", () => {
		expect(plugins.map((p) => p.id)).toEqual([
			"pages.tables",
			"pages.services",
			"pages.chrome",
			"pages.render",
			"pages.panel",
		]);
		expect(pagesTablesPlugin.tables?.page).toBeDefined();
		expect(pagesServicesPlugin.services).toBeDefined();
		expect(pagesServicesPlugin.requiredDeps).toEqual([platformAdminPlugin.id]);
		expect(pagesServicesPlugin.optionalDeps).toEqual([
			richTextServicesPlugin.id,
			schemasServicesPlugin.id,
			layoutsServicesPlugin.id,
		]);
		// The render plugin's guard/loader resolve rich-text content and
		// layout sections, and call Pages.validatedSearch — the
		// Schemas edge lives on pages.services (where the serviceOption
		// is built), so pages.render keeps the rich-text and layouts edges.
		expect(pagesRenderPlugin.optionalDeps).toEqual([
			richTextServicesPlugin.id,
			layoutsServicesPlugin.id,
		]);
		expect(pagesPanelPlugin.optionalDeps).toEqual([
			richTextServicesPlugin.id,
			schemasServicesPlugin.id,
			layoutsServicesPlugin.id,
		]);
	});

	it("declares the console sidebar entry and the app nav component", () => {
		const chrome = pagesChromePlugin.chrome ?? [];
		expect(chrome).toHaveLength(4);
		const sidebar = chrome.find((c) => c.id === "pages.sidebar");
		expect(sidebar?.region).toBe("portal.sidebar");
		expect(sidebar?.content.kind).toBe("sidebarItem");
		const nav = chrome.find((c) => c.id === "pages.nav");
		expect(nav?.region).toBe("app.header.nav");
		expect(nav?.content.kind).toBe("component");
	});

	it("delete dialog actions carry the exact action ids the hook owns", () => {
		const chrome = pagesChromePlugin.chrome ?? [];
		const actions = chrome
			.filter((c) => c.region === "rich-text.delete.actions")
			.map((c) => (c.content.kind === "dialogAction" ? c.content.action : null));
		expect(actions).toEqual([
			{
				id: "pages.unlink-unpublish",
				owner: "pages",
				label: "Unlink & unpublish pages",
				description: "Pages keep their settings but lose the document and return to draft.",
				destructive: false,
			},
			{
				id: "pages.delete-pages",
				owner: "pages",
				label: "Delete pages too",
				description: "Permanently deletes every page using this document.",
				destructive: true,
			},
		]);
	});

	it("declares the wildcard app page and the admin console page", () => {
		const page = pagesRenderPlugin.pages?.[0];
		expect(page?.path).toBe("/*");
		expect(page?.context).toBe("app");
		expect(page?.guard).toBeTypeOf("function");
		expect(page?.loader).toBeTypeOf("function");
		const admin = pagesPanelPlugin.panel?.pages?.[0];
		expect(admin?.path).toBe("/platform/pages");
		expect(admin?.guard).toBeTypeOf("function");
		expect(admin?.loader).toBeTypeOf("function");
	});
});

describe("pages page effects", () => {
	let runtime: ManagedRuntime.ManagedRuntime<unknown, never>;
	const makeDeps = (db: ReturnType<typeof makeDb>) =>
		Layer.merge(
			Layer.succeed(Db, db),
			Layer.succeed(PlatformAdmin, makePlatformAdminGate(parsePlatformAdminEmails("admin@x.com"))),
		);
	let deps: ReturnType<typeof makeDeps>;
	let sharedDb: ReturnType<typeof makeDb>;

	const asPrincipal = <A, E>(
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		runtime.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	// Same principal provisioning for the auxiliary runtimes that add
	// the RichTexts stub on top of the shared deps.
	const asPrincipalIn = <A, E>(
		rt: ManagedRuntime.ManagedRuntime<unknown, never>,
		principal: { userId: string; email?: string } | null,
		effect: Effect.Effect<A, E, unknown>,
	) =>
		rt.runPromise(
			Effect.provideService(effect, Principal, principal) as Effect.Effect<A, E, never>,
		);

	beforeAll(async () => {
		const db = makeDb(makeD1(PAGES_TEST_DDL));
		sharedDb = db;
		deps = makeDeps(db);
		// Merge `deps` into the runtime too: the admin page guard yields
		// PlatformAdmin directly, not just through Pages.
		runtime = ManagedRuntime.make(
			Layer.mergeAll(PagesLive.pipe(Layer.provide(deps)), deps) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		const now = new Date();
		await db.insert(page).values([
			{
				path: "/pub",
				title: "Pub",
				richTextId: 42,
				published: true,
				showInNav: true,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				path: "/draft",
				title: "Draft",
				richTextId: null,
				published: false,
				showInNav: false,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				path: "/pub-bare",
				title: "PubBare",
				richTextId: null,
				published: true,
				showInNav: false,
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
		]);
	});

	afterAll(() => runtime.dispose());

	it("wildcard guard admits published paths and denies the rest", async () => {
		const guard = pagesRenderPlugin.pages![0]!.guard!;
		await expect(asPrincipal(null, guard("/pub"))).resolves.toBe(true);
		await expect(asPrincipal(null, guard("/draft"))).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/missing"))).resolves.toBe(false);
	});

	it("wildcard loader returns the published row with null content when the rich-text service is absent", async () => {
		const loader = pagesRenderPlugin.pages![0]!.loader!;
		const row = (await asPrincipal(null, loader("/pub/"))) as {
			title?: string;
			content?: unknown;
			richTextId?: number | null;
		} | null;
		expect(row?.title).toBe("Pub");
		expect(row?.richTextId).toBe(42);
		expect(row?.content).toBeNull();
		await expect(asPrincipal(null, loader("/draft"))).resolves.toBeNull();
	});

	it("wildcard loader resolves the referenced document when the rich-text service is present", async () => {
		const value = [{ type: "p", children: [{ text: "Hello" }] }];
		const richTexts = RichTexts.of({
			adminList: () =>
				Effect.succeed([{ id: 42, title: "Doc", createdAt: new Date(0), updatedAt: new Date(0) }]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: (id: number) =>
				Effect.succeed(
					id === 42
						? {
								id: 42,
								title: "Doc",
								createdAt: new Date(0),
								updatedAt: new Date(0),
								content: value,
							}
						: null,
				),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(RichTexts, richTexts),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesRenderPlugin.pages![0]!.loader!;
			const row = (await asPrincipalIn(rt, null, loader("/pub"))) as {
				content?: unknown;
			} | null;
			expect(row?.content).toEqual(value);
			// A published page without a document reference resolves null.
			const bare = (await asPrincipalIn(rt, null, loader("/pub-bare"))) as {
				content?: unknown;
			} | null;
			expect(bare?.content).toBeNull();
		} finally {
			await rt.dispose();
		}
	});

	it("admin page guard allows admins and denies everyone else", async () => {
		const guard = pagesPanelPlugin.panel!.pages![0]!.guard!;
		await expect(
			asPrincipal({ userId: "a1", email: "admin@x.com" }, guard("/platform/pages")),
		).resolves.toBe(true);
		await expect(
			asPrincipal({ userId: "u1", email: "doc@x.com" }, guard("/platform/pages")),
		).resolves.toBe(false);
		await expect(asPrincipal(null, guard("/platform/pages"))).resolves.toBe(false);
	});

	it("admin page loader lists rows and docs for admins, empties for others", async () => {
		const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
		const data = (await asPrincipal(
			{ userId: "a1", email: "admin@x.com" },
			loader("/platform/pages"),
		)) as {
			pages: readonly { path: string }[];
			docs: readonly { id: number }[];
			richTextEnabled: boolean;
			schemas: readonly { id: number }[];
			searchSchemaEnabled: boolean;
			layouts: readonly { id: number }[];
			layoutEnabled: boolean;
		};
		expect(data.pages.map((r) => r.path)).toEqual(["/draft", "/pub", "/pub-bare"]);
		// No RichTexts service in this runtime — the picker is empty
		// and the console hides the content-document field.
		expect(data.docs).toEqual([]);
		expect(data.richTextEnabled).toBe(false);
		// No Schemas service either — the search-schema picker is
		// empty and the console hides that field too.
		expect(data.schemas).toEqual([]);
		expect(data.searchSchemaEnabled).toBe(false);
		// No Layouts service either — the layout picker is empty and
		// the console hides that field too.
		expect(data.layouts).toEqual([]);
		expect(data.layoutEnabled).toBe(false);
		const denied = (await asPrincipal(
			{ userId: "u1", email: "doc@x.com" },
			loader("/platform/pages"),
		)) as {
			pages: readonly unknown[];
			docs: readonly unknown[];
			layouts: readonly unknown[];
		};
		expect(denied).toEqual({
			pages: [],
			docs: [],
			richTextEnabled: false,
			schemas: [],
			searchSchemaEnabled: false,
			layouts: [],
			layoutEnabled: false,
		});
	});

	it("admin page loader surfaces rich-text document options when the service is present", async () => {
		const richTexts = RichTexts.of({
			adminList: () =>
				Effect.succeed([
					{
						id: 42,
						title: "Doc",
						createdAt: new Date(0),
						updatedAt: new Date(0),
					},
				]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(RichTexts, richTexts),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
			const data = (await asPrincipalIn(
				rt,
				{ userId: "a1", email: "admin@x.com" },
				loader("/platform/pages"),
			)) as {
				pages: readonly { path: string }[];
				docs: readonly { id: number; title: string }[];
				richTextEnabled: boolean;
			};
			expect(data.pages.map((r) => r.path)).toEqual(["/draft", "/pub", "/pub-bare"]);
			expect(data.docs).toEqual([{ id: 42, title: "Doc" }]);
			expect(data.richTextEnabled).toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("admin page loader surfaces search-schema options when the service is present", async () => {
		const schemas = Schemas.of({
			adminList: () =>
				Effect.succeed([
					{
						id: 3,
						name: "Filters",
						description: "Query params",
						createdAt: new Date(0),
						updatedAt: new Date(0),
					},
				]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
			validate: () => Effect.succeed({ valid: true, issues: [] }),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(Schemas, schemas),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
			const data = (await asPrincipalIn(
				rt,
				{ userId: "a1", email: "admin@x.com" },
				loader("/platform/pages"),
			)) as {
				schemas: readonly { id: number; name: string; description: string | null }[];
				searchSchemaEnabled: boolean;
			};
			expect(data.schemas).toEqual([{ id: 3, name: "Filters", description: "Query params" }]);
			expect(data.searchSchemaEnabled).toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("wildcard loader cleans search params for schema-bound pages when Schemas is present", async () => {
		// Schema-bound published page; inserted last so the earlier
		// adminList-order assertions are unaffected.
		const now = new Date();
		await sharedDb.insert(page).values({
			path: "/pub-search",
			title: "PubSearch",
			richTextId: null,
			searchSchemaId: 7,
			published: true,
			showInNav: false,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
		});
		const schemas = Layer.succeed(
			Schemas,
			Schemas.of({
				adminList: () => Effect.succeed([]),
				adminGet: () => Effect.succeed(null),
				adminCreate: () => Effect.succeed(null),
				adminUpdate: () => Effect.die("unused"),
				adminRemove: () => Effect.die("unused"),
				getById: () => Effect.succeed(null),
				// Schema 7 rejects any payload carrying a "bad" key.
				validate: (_schemaId: number, data: unknown) =>
					Effect.succeed(
						typeof data === "object" && data !== null && "bad" in data
							? {
									valid: false,
									issues: [{ path: "bad.deep", keyword: "type", message: "no" }],
								}
							: { valid: true, issues: [] },
					),
			}),
		);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				// Schemas must be provided INTO PagesLive:
				// validatedSearch resolves Effect.serviceOption at
				// layer-build time.
				PagesLive.pipe(Layer.provide(Layer.mergeAll(deps, schemas))),
				deps,
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesRenderPlugin.pages![0]!.loader!;
			// "bad" is stripped, "q" survives — same cleaning the retired
			// client-side fn produced, now inside the loader.
			const cleaned = (await asPrincipalIn(
				rt,
				null,
				loader("/pub-search", { q: "x", bad: { deep: 1 } }),
			)) as { search?: Record<string, unknown> } | null;
			expect(cleaned?.search).toEqual({ q: "x" });
			// No search argument → empty cleaned record, field still set.
			const empty = (await asPrincipalIn(rt, null, loader("/pub-search"))) as {
				search?: Record<string, unknown>;
			} | null;
			expect(empty?.search).toEqual({});
			// Unbound page: no `search` field at all.
			const unbound = (await asPrincipalIn(rt, null, loader("/pub", { bad: 1 }))) as {
				search?: unknown;
			} | null;
			expect(unbound?.search).toBeUndefined();
		} finally {
			await rt.dispose();
		}
	});

	it("admin page loader surfaces layout options when the service is present", async () => {
		const layouts = Layouts.of({
			adminList: () =>
				Effect.succeed([
					{
						id: 5,
						name: "Landing",
						description: "Landing body",
						sectionCount: 2,
						createdAt: new Date(0),
						updatedAt: new Date(0),
					},
				]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			adminSetBuilderJson: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
			resolveForPage: () => Effect.succeed([]),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(Layouts, layouts),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
			const data = (await asPrincipalIn(
				rt,
				{ userId: "a1", email: "admin@x.com" },
				loader("/platform/pages"),
			)) as {
				layouts: readonly { id: number; name: string; description: string | null }[];
				layoutEnabled: boolean;
			};
			expect(data.layouts).toEqual([{ id: 5, name: "Landing", description: "Landing body" }]);
			expect(data.layoutEnabled).toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("admin page loader degrades the layout picker to empty on Forbidden", async () => {
		// A present-but-denying Layouts service: the loader's
		// `catchTag("Forbidden")` arm keeps the picker empty while the
		// flag still reports the service as installed.
		const layouts = Layouts.of({
			adminList: () => Effect.fail(new Forbidden({ path: "platform.admin" })),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			adminSetBuilderJson: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
			resolveForPage: () => Effect.succeed([]),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(Layouts, layouts),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
			const data = (await asPrincipalIn(
				rt,
				{ userId: "a1", email: "admin@x.com" },
				loader("/platform/pages"),
			)) as {
				layouts: readonly unknown[];
				layoutEnabled: boolean;
			};
			expect(data.layouts).toEqual([]);
			expect(data.layoutEnabled).toBe(true);
		} finally {
			await rt.dispose();
		}
	});

	it("wildcard loader resolves layout sections when the Layouts service is present", async () => {
		const now = new Date();
		await sharedDb.insert(page).values({
			path: "/pub-layout",
			title: "PubLayout",
			richTextId: null,
			searchSchemaId: null,
			layoutId: 5,
			published: true,
			showInNav: false,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
		});
		const value = [{ type: "p", children: [{ text: "Section" }] }];
		const layouts = Layer.succeed(
			Layouts,
			Layouts.of({
				adminList: () => Effect.succeed([]),
				adminGet: () => Effect.succeed(null),
				adminCreate: () => Effect.succeed(null),
				adminUpdate: () => Effect.die("unused"),
				adminRemove: () => Effect.die("unused"),
				adminSetBuilderJson: () => Effect.die("unused"),
				getById: () => Effect.succeed(null),
				resolveForPage: (layoutId: number) =>
					Effect.succeed(
						layoutId === 5
							? [
									{ id: "s1", title: "Hero", content: value },
									{ id: "s2", title: "Body", content: value },
								]
							: null,
					),
			}),
		);
		const rt = ManagedRuntime.make(
			Layer.mergeAll(PagesLive.pipe(Layer.provide(deps)), deps, layouts) as Layer.Layer<
				unknown,
				never,
				never
			>,
		);
		try {
			const loader = pagesRenderPlugin.pages![0]!.loader!;
			const row = (await asPrincipalIn(rt, null, loader("/pub-layout"))) as {
				layoutSections?: readonly { title: string; content: unknown }[] | null;
			} | null;
			expect(row?.layoutSections).toEqual([
				{ id: "s1", title: "Hero", content: value },
				{ id: "s2", title: "Body", content: value },
			]);
			// Unbound pages carry no layout sections (null → single-doc path).
			const unbound = (await asPrincipalIn(rt, null, loader("/pub"))) as {
				layoutSections?: unknown;
			} | null;
			expect(unbound?.layoutSections).toBeNull();
		} finally {
			await rt.dispose();
		}
	});

	it("wildcard loader leaves layoutSections null when the Layouts service is absent", async () => {
		// The shared runtime has no Layouts layer — the field stays null
		// and the page renders its single document as before.
		const loader = pagesRenderPlugin.pages![0]!.loader!;
		const row = (await asPrincipal(null, loader("/pub-layout"))) as {
			layoutSections?: unknown;
		} | null;
		expect(row?.layoutSections).toBeNull();
	});

	it("wildcard loader passes search through when the Schemas service is absent", async () => {
		// The shared runtime has no Schemas layer — validatedSearch
		// degrades to the raw params.
		const loader = pagesRenderPlugin.pages![0]!.loader!;
		const row = (await asPrincipal(null, loader("/pub-search", { bad: 1 }))) as {
			search?: Record<string, unknown>;
		} | null;
		expect(row?.search).toEqual({ bad: 1 });
	});

	it("wildcard loader resolves null content when the referenced document is missing", async () => {
		// richTextId points at a document the RichTexts service does not
		// have — `doc?.content ?? null` degrades the body to null.
		const now = new Date();
		await sharedDb.insert(page).values({
			path: "/pub-missing-doc",
			title: "MissingDoc",
			richTextId: 99,
			published: true,
			showInNav: false,
			sortOrder: 0,
			createdAt: now,
			updatedAt: now,
		});
		const richTexts = RichTexts.of({
			adminList: () => Effect.succeed([]),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(RichTexts, richTexts),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesRenderPlugin.pages![0]!.loader!;
			const row = (await asPrincipalIn(rt, null, loader("/pub-missing-doc"))) as {
				content?: unknown;
			} | null;
			expect(row?.content).toBeNull();
		} finally {
			await rt.dispose();
		}
	});

	it("admin page loader empties pickers whose adminList is Forbidden", async () => {
		const richTexts = RichTexts.of({
			adminList: () => Effect.fail(new Forbidden({ path: "rich-text.adminList" })),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
		});
		const schemas = Schemas.of({
			adminList: () => Effect.fail(new Forbidden({ path: "schemas.adminList" })),
			adminGet: () => Effect.succeed(null),
			adminCreate: () => Effect.succeed(null),
			adminUpdate: () => Effect.die("unused"),
			adminRemove: () => Effect.die("unused"),
			getById: () => Effect.succeed(null),
			validate: () => Effect.succeed({ valid: true, issues: [] }),
		});
		const rt = ManagedRuntime.make(
			Layer.mergeAll(
				PagesLive.pipe(Layer.provide(deps)),
				deps,
				Layer.succeed(RichTexts, richTexts),
				Layer.succeed(Schemas, schemas),
			) as Layer.Layer<unknown, never, never>,
		);
		try {
			const loader = pagesPanelPlugin.panel!.pages![0]!.loader!;
			const data = (await asPrincipalIn(
				rt,
				{ userId: "a1", email: "admin@x.com" },
				loader("/platform/pages"),
			)) as {
				docs: readonly unknown[];
				richTextEnabled: boolean;
				schemas: readonly unknown[];
				searchSchemaEnabled: boolean;
			};
			// The services are present (the fields stay enabled) but their
			// Forbidden adminList degrades each picker to empty.
			expect(data.docs).toEqual([]);
			expect(data.richTextEnabled).toBe(true);
			expect(data.schemas).toEqual([]);
			expect(data.searchSchemaEnabled).toBe(true);
		} finally {
			await rt.dispose();
		}
	});
});
