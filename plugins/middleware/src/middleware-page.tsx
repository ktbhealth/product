import {
	middlewareScopeMatches,
	type MiddlewareRouteInfo,
	type PanelPageContext,
} from "@ktb/kernel";
import type { MiddlewareStageRow } from "@ktb/platform/middleware";
import { sliceMessages } from "@ktb/i18n";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { I18N_NAMESPACE, middlewareMessages, type MiddlewareMessages } from "./i18n.ts";

/**
 * /platform/middleware — the request-pipeline inspector (PL-015,
 * read-only v1): every collected middleware stage in effective run
 * order with its scope and live enablement, plus the effective chain
 * each registered page route resolves. Chain computation is the same
 * pure scope matching the runner applies (`middlewareScopeMatches`
 * over the server-sorted rows) — what the page shows is what
 * `pageData` executes.
 */

export interface MiddlewarePageData {
	readonly stages: readonly MiddlewareStageRow[] | null;
	readonly routes: readonly MiddlewareRouteInfo[] | null;
}

const scopeLabel = (scope: MiddlewareStageRow["scope"], m: MiddlewareMessages): string => {
	if (scope === undefined) return m.scopeAll;
	const parts: string[] = [];
	if (scope.context !== undefined) parts.push(`context:${scope.context}`);
	if (scope.routeKey !== undefined) parts.push(`route:${scope.routeKey}`);
	if (scope.path !== undefined) parts.push(`path:${scope.path}`);
	return parts.length === 0 ? m.scopeAll : parts.join(" ");
};

/** Enabled stages whose scope claims `route`, in the server-sorted
 * run order — the effective chain the dispatcher executes. */
const chainFor = (
	stages: readonly MiddlewareStageRow[],
	route: MiddlewareRouteInfo,
): readonly MiddlewareStageRow[] =>
	stages.filter(
		(s) =>
			s.enabled &&
			middlewareScopeMatches(s.scope, {
				path: route.path,
				context: route.context,
				routeKey: route.routeKey,
			}),
	);

export function MiddlewarePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const d = (data ?? {}) as Partial<MiddlewarePageData>;
	const stages = d.stages ?? null;
	const routes = d.routes ?? null;
	const locale = ctx.locale;
	const m = sliceMessages(ctx.i18n, I18N_NAMESPACE, middlewareMessages(locale));

	if (stages === null || routes === null) {
		return (
			<div className="border-border rounded-md border px-4 py-6 text-sm">
				<span className="font-medium">{m.unavailableTitle}</span>
				<span className="text-muted-foreground"> — {m.unavailableDescription}</span>
			</div>
		);
	}

	return (
		<div className="space-y-8">
			<header className="space-y-1">
				<h1 className="text-2xl font-bold tracking-tight">{m.title}</h1>
				<p className="text-sm text-muted-foreground">{m.description}</p>
			</header>

			<section className="space-y-3">
				<div>
					<h2 className="text-lg font-semibold">{m.stagesTitle}</h2>
					<p className="text-sm text-muted-foreground">
						{m.stagesDescription} {m.stageCount(stages.length)}
					</p>
				</div>
				<div className="border-border overflow-x-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{m.colOrder}</TableHead>
								<TableHead>{m.colId}</TableHead>
								<TableHead>{m.colPlugin}</TableHead>
								<TableHead>{m.colOrigin}</TableHead>
								<TableHead>{m.colScope}</TableHead>
								<TableHead>{m.colEnabled}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{stages.map((s, i) => (
								<TableRow key={`${s.pluginId}:${s.id}:${i}`}>
									<TableCell className="font-mono text-xs">{s.order ?? "—"}</TableCell>
									<TableCell className="font-mono text-xs">{s.id}</TableCell>
									<TableCell className="text-xs">{s.pluginId}</TableCell>
									<TableCell className="text-xs">
										{s.origin === "builtin" ? m.originBuiltin : m.originPlugin}
									</TableCell>
									<TableCell className="font-mono text-xs">{scopeLabel(s.scope, m)}</TableCell>
									<TableCell className="text-xs">{s.enabled ? m.enabled : m.disabled}</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			</section>

			<section className="space-y-3">
				<div>
					<h2 className="text-lg font-semibold">{m.routesTitle}</h2>
					<p className="text-sm text-muted-foreground">
						{m.routesDescription} {m.routeCount(routes.length)}
					</p>
				</div>
				<div className="border-border overflow-x-auto rounded-md border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{m.colRoute}</TableHead>
								<TableHead>{m.colContext}</TableHead>
								<TableHead>{m.colChain}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{routes.map((r) => {
								const chain = chainFor(stages, r);
								return (
									<TableRow key={`${r.context}:${r.path}`}>
										<TableCell className="font-mono text-xs">{r.path}</TableCell>
										<TableCell className="text-xs">{r.context}</TableCell>
										<TableCell className="font-mono text-xs">
											{chain.length === 0 ? m.chainEmpty : chain.map((s) => s.id).join(" → ")}
										</TableCell>
									</TableRow>
								);
							})}
						</TableBody>
					</Table>
				</div>
			</section>
		</div>
	);
}
