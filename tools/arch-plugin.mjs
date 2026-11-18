/**
 * Local `arch` Oxlint JS plugin — wraps @ktbhealth/workspace's
 * eslint-plugin-arch bundle and replaces ONLY the `plugin-contract`
 * rule with a copy that also accepts `clientStub({...})` entries in
 * `plugins/<pkg>/src/client.ts` (T-157).
 *
 * Why: the published rule (v0.1.1@eslint-plugin-arch) only accepts
 * `definePlugin` initializers, which blocks the T-149 `clientStub`
 * adoption for server-only client mirrors. The upstream fix lives in
 * ktbhealth/workspace `packages/eslint-plugin-plugin-contract` —
 * once it is tagged and the dep bumped, delete this file and point
 * `lint.jsPlugins` back at `@ktbhealth/workspace/eslint-plugin-arch`.
 *
 * The rule below is a verbatim port of the upstream source (same AST
 * checks, same self-filtering to plugins/<pkg>/src/{index,client}.ts)
 * with `clientStub` admitted for client.ts entries only — server
 * index.ts manifests must still use `definePlugin`.
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

export default {
	meta: { name: "arch" },
	rules: {
		...archPlugin.rules,
		"plugin-contract": pluginContract,
	},
};
