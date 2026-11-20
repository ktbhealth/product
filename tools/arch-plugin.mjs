/**
 * Local `arch` Oxlint JS plugin — wraps @ktbhealth/workspace's
 * eslint-plugin-arch bundle and replaces TWO rules with local copies:
 *
 * 1. `plugin-contract` — also accepts `clientStub({...})` entries in
 *    `plugins/<pkg>/src/client.ts` (T-157).
 * 2. `package-boundary` — drops the `schema.ts` basename exemption
 *    (T-143): plugin schema modules now import FK targets and the
 *    table DSL through `@ktb/<plugin>/schema` and
 *    `@ktb/db/{table,auth}` package specifiers, which drizzle-kit's
 *    tsx loader resolves as long as the dep edge is declared in
 *    package.json.
 *
 * Why: the published rules (v0.1.5@eslint-plugin-arch) predate both
 * changes. The upstream fixes live in ktbhealth/workspace
 * `packages/eslint-plugin-plugin-contract` and
 * `packages/eslint-plugin-package-boundary` — once they are tagged and
 * the dep bumped, delete this file and point `lint.jsPlugins` back at
 * `@ktbhealth/workspace/eslint-plugin-arch`.
 *
 * The rules below are verbatim ports of the upstream sources (same AST
 * checks) with the noted deltas: `clientStub` admitted for client.ts
 * entries only in plugin-contract (server index.ts manifests must
 * still use `definePlugin`), and `schema.ts` removed from the
 * package-boundary exemption list (`*.gen.*` and `*.test.*` stay —
 * schema.gen.ts is still a relative-path aggregation by design).
 */

import archPlugin from "@ktbhealth/workspace/eslint-plugin-arch";

const PLUGIN_ENTRY_RE = /(?:^|[/\\])plugins[/\\][^/\\]+[/\\]src[/\\](?:index|client)\.ts$/;
const CLIENT_ENTRY_RE = /(?:^|[/\\])client\.ts$/;
const KERNEL = "@ktb/kernel";

const importedName = (spec) => spec.imported?.name ?? spec.imported?.value;

const namedImports = (program) => {
	const map = new Map();
	for (const stmt of program.body) {
		if (stmt.type !== "ImportDeclaration") continue;
		for (const spec of stmt.specifiers ?? []) {
			if (spec.type === "ImportSpecifier" && spec.local?.type === "Identifier") {
				map.set(spec.local.name, {
					source: stmt.source.value,
					imported: importedName(spec),
				});
			}
		}
	}
	return map;
};

const topLevelDeclarators = (program) => {
	const decls = new Map();
	for (const stmt of program.body) {
		const declaration =
			stmt.type === "VariableDeclaration"
				? stmt
				: stmt.type === "ExportNamedDeclaration" && stmt.declaration?.type === "VariableDeclaration"
					? stmt.declaration
					: undefined;
		if (!declaration) continue;
		for (const d of declaration.declarations) {
			if (d.id.type === "Identifier") decls.set(d.id.name, d);
		}
	}
	return decls;
};

const exportedNames = (program) => {
	const names = new Set();
	for (const stmt of program.body) {
		if (stmt.type !== "ExportNamedDeclaration") continue;
		const decl = stmt.declaration;
		if (decl?.type === "VariableDeclaration") {
			for (const d of decl.declarations) {
				if (d.id.type === "Identifier") names.add(d.id.name);
			}
		} else if (decl?.id?.type === "Identifier") {
			names.add(decl.id.name);
		}
		for (const spec of stmt.specifiers ?? []) {
			const exported = spec.exported?.name ?? spec.exported?.value;
			if (exported) names.add(exported);
		}
	}
	return names;
};

const isEntryInit = (init, imports, isClientEntry) => {
	const callee = init?.type === "CallExpression" ? init.callee : undefined;
	if (
		callee?.type !== "Identifier" ||
		init.arguments.length === 0 ||
		init.arguments[0]?.type !== "ObjectExpression"
	) {
		return false;
	}
	const binding = imports.get(callee.name);
	if (binding?.source !== KERNEL) return false;
	return (
		binding.imported === "definePlugin" || (isClientEntry && binding.imported === "clientStub")
	);
};

const pluginContract = {
	create(context) {
		return {
			Program(node) {
				if (!PLUGIN_ENTRY_RE.test(context.filename)) return;
				const isClientEntry = CLIENT_ENTRY_RE.test(context.filename);

				const imports = namedImports(node);
				const decls = topLevelDeclarators(node);
				const declarator = decls.get("plugins");
				const elements =
					declarator?.init?.type === "ArrayExpression" ? declarator.init.elements : undefined;

				if (
					!exportedNames(node).has("plugins") ||
					elements === undefined ||
					elements.length === 0
				) {
					context.report({
						node,
						message:
							"plugin entry must export `plugins` — a non-empty array of `definePlugin({...})` (or `clientStub({...})` in client.ts) plugins for host discovery (arch-plugin-contract/plugin-contract)",
					});
					return;
				}

				for (const el of elements) {
					const init =
						el?.type === "Identifier"
							? decls.get(el.name)?.init
							: el?.type === "CallExpression"
								? el
								: undefined;
					if (init === undefined || !isEntryInit(init, imports, isClientEntry)) {
						context.report({
							node: el ?? node,
							message:
								'`plugins` entries must be `definePlugin({...})` calls (or `clientStub({...})` in client.ts) or consts initialized with them imported from "@ktb/kernel" (arch-plugin-contract/plugin-contract)',
						});
					}
				}
			},
		};
	},
};

/* ------------------------------------------------------------------ */
/* package-boundary — verbatim port of eslint-plugin-package-boundary  */
/* minus the `schema.ts` basename exemption (T-143).                  */
/* ------------------------------------------------------------------ */

/** `<abs>/plugins/<pkg>` (or packages/apps/evals) prefix of a filename. */
const PACKAGE_ROOT_RE = /^(.*[/\\])?(?:plugins|packages|apps|evals)[/\\][^/\\]+/;
// Upstream also exempts `schema\.tsx?` — dropped here: schema modules
// use package specifiers now. `*.gen.*` stays (schema.gen.ts is a
// generated relative-path aggregation) and `*.test.*` stays.
const BOUNDARY_EXEMPT_BASENAME_RE = /(?:^|[/\\])(?:[^/\\]*\.gen\.tsx?|[^/\\]*\.test\.tsx?)$/;

/** Resolve "." and ".." segments in a "/" -joined path. */
const normalizePath = (path) => {
	const parts = [];
	for (const seg of path.split("/")) {
		if (seg === "" || seg === ".") continue;
		if (seg === "..") parts.pop();
		else parts.push(seg);
	}
	return parts.join("/");
};

const BOUNDARY_MESSAGE =
	"relative import escapes the package root — import through the package's export map instead (arch-boundary/package-boundary)";

const packageBoundary = {
	create(context) {
		const filename = context.filename.replaceAll("\\", "/");
		const rootMatch = filename.match(PACKAGE_ROOT_RE);
		if (rootMatch === null || BOUNDARY_EXEMPT_BASENAME_RE.test(filename)) return {};
		// normalizePath drops the leading "/" — normalize the root the
		// same way so the prefix comparison below is apples-to-apples.
		const root = normalizePath(rootMatch[0]);

		const checkSource = (node, source) => {
			if (typeof source !== "string" || !source.startsWith(".")) return;
			const dir = filename.slice(0, filename.lastIndexOf("/") + 1);
			const resolved = normalizePath(`${dir}${source}`);
			if (resolved === root || resolved.startsWith(`${root}/`)) return;
			context.report({
				node,
				message: `${BOUNDARY_MESSAGE}: "${source}"`,
			});
		};

		return {
			ImportDeclaration(node) {
				checkSource(node, node.source?.value);
			},
			ExportNamedDeclaration(node) {
				if (node.source) checkSource(node, node.source.value);
			},
			ExportAllDeclaration(node) {
				if (node.source) checkSource(node, node.source.value);
			},
			ImportExpression(node) {
				const source = node.source;
				checkSource(node, source?.type === "Literal" ? source.value : undefined);
			},
		};
	},
};

export default {
	meta: { name: "arch" },
	rules: {
		...archPlugin.rules,
		"plugin-contract": pluginContract,
		"package-boundary": packageBoundary,
	},
};
