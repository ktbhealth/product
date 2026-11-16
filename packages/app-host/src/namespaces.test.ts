import { describe, expect, it } from "vitest";

import { definePlugin, type Plugin } from "@ktb/kernel";

import { allNamespaces, namespacesForPath } from "./namespaces.ts";

const pagePlugin = (id: string, paths: readonly string[]): Plugin =>
	definePlugin({
		id,
		pages: paths.map((path) => ({
			id: `${id}:${path}`,
			path,
			component: () => null,
		})),
	});

const chromePlugin = (
	id: string,
	when: { paths?: readonly string[]; exceptPaths?: readonly string[] } | undefined,
): Plugin =>
	definePlugin({
		id,
		chrome: [
			{
				id: `${id}:c`,
				region: "test",
				...(when ? { when } : {}),
				content: { kind: "note", key: "k", fallback: "f" },
			},
		],
	});

describe("namespacesForPath", () => {
	it("always includes the app host namespace", () => {
		expect(namespacesForPath([], "/anything")).toEqual(["app"]);
	});

	it("maps the winning page's plugin id to its domain namespace", () => {
		const plugins = [pagePlugin("patients.pages", ["/patients", "/patients/*"])];
		expect(namespacesForPath(plugins, "/patients/42")).toEqual(["app", "patients"]);
	});

	it("exact path beats wildcard across plugins", () => {
		const plugins = [
			pagePlugin("wild.plugin", ["/x/*"]),
			pagePlugin("exact.plugin", ["/x/special"]),
		];
		expect(namespacesForPath(plugins, "/x/special")).toEqual(["app", "exact"]);
	});

	it("longest wildcard base wins", () => {
		const plugins = [pagePlugin("short.plugin", ["/x/*"]), pagePlugin("long.plugin", ["/x/y/*"])];
		expect(namespacesForPath(plugins, "/x/y/z")).toEqual(["app", "long"]);
	});

	it("includes chrome-matched namespaces even without a page", () => {
		const withPath = [chromePlugin("theme.chrome", { paths: ["/about"] })];
		expect(namespacesForPath(withPath, "/about")).toEqual(["app", "theme"]);
		expect(namespacesForPath(withPath, "/other")).toEqual(["app"]);
	});

	it("exceptPaths suppresses a chrome namespace", () => {
		const plugins = [chromePlugin("theme.chrome", { paths: ["/*"], exceptPaths: ["/admin"] })];
		expect(namespacesForPath(plugins, "/admin")).toEqual(["app"]);
		expect(namespacesForPath(plugins, "/page")).toEqual(["app", "theme"]);
	});

	it("panel.pages count as page sources", () => {
		const plugin = definePlugin({
			id: "users.panel",
			panel: {
				pages: [{ id: "u", path: "/platform/users", component: () => null }],
			},
		});
		expect(namespacesForPath([plugin], "/platform/users")).toEqual(["app", "users"]);
	});

	it("keeps sub-domain segments — concern suffix is stripped, not the domain", () => {
		const plugins = [
			pagePlugin("eval.credentials.panel", ["/platform/eval/credentials"]),
			chromePlugin("eval.persona.chrome", { paths: ["/eval/*"] }),
		];
		expect(namespacesForPath(plugins, "/platform/eval/credentials")).toEqual([
			"app",
			"eval.credentials",
		]);
		expect(namespacesForPath(plugins, "/eval/x")).toEqual(["app", "eval.persona"]);
	});
});

describe("allNamespaces", () => {
	it("collects every plugin domain + app", () => {
		const plugins = [pagePlugin("patients.pages", ["/p"]), chromePlugin("theme.chrome", undefined)];
		expect(allNamespaces(plugins)).toEqual(["app", "patients", "theme"]);
	});
});
