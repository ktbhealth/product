import { TablePage, type Column } from "@ktb/views/table";

/** One row of the /platform/routes read-only table — the serializable
 * projection of a `RouteDefinition` (@ktb/platform `routes`) the panel
 * loader returns. */
export interface RouteRow {
	readonly key: string;
	readonly path: string;
	readonly params?: readonly string[];
	readonly portal?: string;
	readonly context?: "app" | "portal";
	readonly pluginId: string;
}

const COLUMNS: readonly Column<RouteRow>[] = [
	{ key: "key", header: "Key", render: (row) => <code>{row.key}</code> },
	{ key: "path", header: "Path", render: (row) => <code>{row.path}</code> },
	{
		key: "params",
		header: "Params",
		render: (row) =>
			row.params === undefined || row.params.length === 0 ? (
				<span className="text-muted-foreground">—</span>
			) : (
				row.params.join(", ")
			),
	},
	{
		key: "portal",
		header: "Portal",
		render: (row) => row.portal ?? <span className="text-muted-foreground">—</span>,
	},
	{
		key: "context",
		header: "Context",
		render: (row) => row.context ?? <span className="text-muted-foreground">—</span>,
	},
	{ key: "plugin", header: "Plugin", render: (row) => row.pluginId },
];

/** Read-only route-registry table (PL-011 phase 3): every registered
 * route key — explicit `route` contributions plus defs derived from
 * page descriptors — with its path template, params and owner. */
export function RoutesPage({ routes }: { routes: readonly RouteRow[] }) {
	return (
		<TablePage>
			<TablePage.Header
				title="Routes"
				description="Registered route keys, path templates and owning plugins."
			/>
			<TablePage.Table
				columns={COLUMNS}
				rows={routes}
				rowKey={(row) => row.key}
				empty={{ title: "No routes registered." }}
			/>
		</TablePage>
	);
}
