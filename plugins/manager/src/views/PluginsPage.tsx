import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { EllipsisVerticalIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@ktbhealth/ui/components/dropdown-menu";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Pagination,
	PaginationContent,
	PaginationEllipsis,
	PaginationItem,
	PaginationLink,
	PaginationNext,
	PaginationPrevious,
} from "@ktbhealth/ui/components/pagination";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Switch } from "@ktbhealth/ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ktbhealth/ui/components/alert-dialog";
import type { Plugin, PluginConfigSchema } from "@ktb/kernel";

import {
	configFormFields,
	contributionKinds,
	disabledClosure,
	missingRequiredDeps,
	pluginDisplayName,
	type ConfigFormField,
} from "../logic.ts";
import { managerMessages, I18N_NAMESPACE } from "../i18n.ts";
import { MetricsSection } from "./MetricsSection.tsx";
import { getPluginConfigFn, setPluginConfigFn, setPluginEnabledFn } from "../fns.ts";

/** Server-resolved state for one plugin (PluginStates.entries row). */
export interface PluginStateInfo {
	readonly pluginId: string;
	readonly enabled: boolean;
	readonly config: unknown;
}

export interface PluginsPageProps {
	/** Full discovered registry — `ctx.plugins` (enabled AND disabled). */
	readonly plugins: readonly Plugin[];
	/** State map keyed by plugin id, from the page loader. */
	readonly states: ReadonlyMap<string, PluginStateInfo>;
	/** Active UI locale injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
	/** When false, disabling skips the cascade confirm dialog (the
	 * plugin's own `meta.config.cascadeConfirm`, dogfooded). */
	readonly cascadeConfirm?: boolean;
}

type RowStatus = "enabled" | "disabled" | "blocked";
type StatusFilter = "all" | RowStatus;

const PAGE_SIZE = 15;
const SEARCH_CLS = "w-56 sm:w-64";

const statusOf = (enabled: boolean, missing: readonly string[]): RowStatus => {
	// "Blocked" wins over both: required deps off means the plugin can
	// neither stay meaningfully on nor be (re-)enabled until they are.
	if (missing.length > 0) return "blocked";
	return enabled ? "enabled" : "disabled";
};

/** System plugins always count as enabled for filtering purposes. */
const filterStatusOf = (plugin: Plugin, enabled: boolean, missing: readonly string[]): RowStatus =>
	plugin.system === true ? "enabled" : statusOf(enabled, missing);

const configObject = (config: unknown): Record<string, unknown> =>
	typeof config === "object" && config !== null && !Array.isArray(config)
		? (config as Record<string, unknown>)
		: {};

/**
 * Initial field values from the server-merged config: stored value →
 * schema default → type-appropriate empty. Number fields stay `undefined`
 * (unset) rather than `""`/`0` — an empty input must not coerce to 0 and
 * a missing key lets the server fill the default on save.
 */
const initialFormValues = (fields: readonly ConfigFormField[], config: unknown) => {
	const stored = configObject(config);
	return Object.fromEntries(
		fields.map((f) => [
			f.key,
			stored[f.key] ?? f.default ?? (f.type === "number" ? undefined : ""),
		]),
	);
};

/* v8 ignore next -- configFormFields only emits enum fields with options */
const enumOptions = (field: ConfigFormField): readonly string[] => field.options ?? [];

/* v8 ignore next -- enum values are initialized to a string and only assigned strings */
const enumValue = (values: Record<string, unknown>, key: string): string => {
	const v = values[key];
	return typeof v === "string" || typeof v === "number" ? String(v) : "";
};

/** Page-number window for the pagination bar: always first/last, a
 * radius around the current page, ellipsis for the gaps. */
const pageWindow = (page: number, total: number): readonly (number | "…")[] => {
	if (total <= 7) return Array.from({ length: total }, (_, i) => i);
	const pages = new Set<number>([0, total - 1, page - 1, page, page + 1]);
	const sorted = [...pages].filter((p) => p >= 0 && p < total).sort((a, b) => a - b);
	const out: (number | "…")[] = [];
	let prev = -1;
	for (const p of sorted) {
		if (prev !== -1 && p - prev > 1) out.push("…");
		out.push(p);
		prev = p;
	}
	return out;
};

/**
 * /platform/plugins console view (P-058): every discovered plugin with
 * its contributions, dep status and runtime state. Toolbar filters by
 * text/status with client-side pagination; toggles cascade through an
 * alertdialog (dependents are disabled together); enables are refused
 * while required deps are off; `meta.config` plugins get a generated
 * settings form inside a dialog.
 */
export function PluginsPage({
	plugins,
	states,
	i18n,
	locale,
	cascadeConfirm = true,
}: PluginsPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, managerMessages(locale));
	const router = useRouter();
	const [q, setQ] = useState("");
	const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
	const [page, setPage] = useState(0);
	const [configFor, setConfigFor] = useState<Plugin | null>(null);
	const [pendingDisable, setPendingDisable] = useState<readonly string[] | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	// Enabled set: the loader's entries cover every registry id; a plugin
	// missing from the map defaults to enabled (no row = enabled).
	const enabledSet = useMemo(() => {
		const set = new Set<string>();
		for (const p of plugins) set.add(p.id);
		for (const [id, info] of states) if (!info.enabled) set.delete(id);
		return set;
	}, [plugins, states]);

	const rows = useMemo(
		() =>
			plugins.map((plugin) => {
				const enabled = enabledSet.has(plugin.id);
				const missing = missingRequiredDeps(plugins, enabledSet, plugin.id);
				return { plugin, enabled, missing };
			}),
		[plugins, enabledSet],
	);

	const filtered = useMemo(() => {
		const needle = q.trim().toLowerCase();
		return rows.filter(({ plugin, enabled, missing }) => {
			if (statusFilter !== "all" && filterStatusOf(plugin, enabled, missing) !== statusFilter) {
				return false;
			}
			if (needle === "") return true;
			return [
				pluginDisplayName(plugin),
				plugin.id,
				plugin.meta?.description ?? "",
				contributionKinds(plugin).join(" "),
			]
				.join(" ")
				.toLowerCase()
				.includes(needle);
		});
	}, [rows, q, statusFilter]);

	const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
	const safePage = Math.min(page, totalPages - 1);
	const paged = filtered.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

	const applyEnabled = async (ids: readonly string[], enabled: boolean) => {
		setBusy(true);
		setFailed(false);
		try {
			const ok = await setPluginEnabledFn({ data: { ids: [...ids], enabled } });
			if (ok) await router.invalidate();
			else setFailed(true);
		} catch {
			setFailed(true);
		} finally {
			setBusy(false);
			setPendingDisable(null);
		}
	};

	const onToggle = (plugin: Plugin, enabled: boolean) => {
		if (enabled) {
			// Enable is refused client-side while required deps are off —
			// the row shows "blocked" and names them; no auto-enable.
			const missing = missingRequiredDeps(plugins, enabledSet, plugin.id);
			if (missing.length === 0) void applyEnabled([plugin.id], true);
			return;
		}
		const closure = disabledClosure(plugins, plugin.id);
		if (cascadeConfirm && closure.length > 1) setPendingDisable(closure);
		else void applyEnabled(closure, false);
	};

	const pendingNames = (pendingDisable ?? [])
		.map((id) => pluginDisplayName(plugins.find((p) => p.id === id) ?? { id, meta: undefined }))
		.join(", ");

	/* v8 ignore next -- the dialog action only renders while pendingDisable is set */
	const confirmDisable = () => void applyEnabled(pendingDisable ?? [], false);

	const statusLabel = (status: RowStatus) =>
		status === "enabled"
			? t.statusEnabled
			: status === "disabled"
				? t.statusDisabled
				: t.statusBlocked;

	return (
		<PageContainer>
			<PageHeader title={t.title} description={t.description} />
			{failed ? <p className="text-sm text-destructive">{t.configSaveFailed}</p> : null}
			{rows.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t.empty}</p>
			) : (
				<>
					<DataToolbar
						search={
							<Input
								type="search"
								value={q}
								onChange={(e) => {
									setQ(e.target.value);
									setPage(0);
								}}
								placeholder={t.searchPlaceholder}
								aria-label={t.searchLabel}
								className={SEARCH_CLS}
							/>
						}
						filters={
							<Select
								items={[
									{ value: "all", label: t.filterAll },
									{ value: "enabled", label: t.statusEnabled },
									{ value: "disabled", label: t.statusDisabled },
									{ value: "blocked", label: t.statusBlocked },
								]}
								value={statusFilter}
								onValueChange={(v) => {
									setStatusFilter(String(v) as StatusFilter);
									setPage(0);
								}}
							>
								<SelectTrigger size="sm" aria-label={t.statusFilterLabel} className="w-36">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="all">{t.filterAll}</SelectItem>
									<SelectItem value="enabled">{t.statusEnabled}</SelectItem>
									<SelectItem value="disabled">{t.statusDisabled}</SelectItem>
									<SelectItem value="blocked">{t.statusBlocked}</SelectItem>
								</SelectContent>
							</Select>
						}
						resultCount={
							q.trim() === "" && statusFilter === "all"
								? undefined
								: t.filteredCount(filtered.length, rows.length)
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.colPlugin}</TableHead>
									<TableHead>{t.colKind}</TableHead>
									<TableHead>{t.colStatus}</TableHead>
									<TableHead className="w-12 text-right">{t.colActions}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{paged.length === 0 ? (
									<TableRow>
										<TableCell colSpan={4} className="text-xs text-muted-foreground">
											{t.noResults}
										</TableCell>
									</TableRow>
								) : (
									paged.map(({ plugin, enabled, missing }) => (
										<PluginRow
											key={plugin.id}
											plugin={plugin}
											enabled={enabled}
											missing={missing}
											busy={busy}
											t={t}
											statusLabel={statusLabel}
											onToggle={(next) => onToggle(plugin, next)}
											onConfigure={() => setConfigFor(plugin)}
										/>
									))
								)}
							</TableBody>
						</Table>
					</div>
					{totalPages > 1 ? (
						<Pagination className="justify-end">
							<PaginationContent>
								<PaginationItem>
									<PaginationPrevious
										text={t.paginationPrevious}
										aria-disabled={safePage === 0}
										className={safePage === 0 ? "pointer-events-none opacity-50" : undefined}
										onClick={(e) => {
											e.preventDefault();
											if (safePage > 0) setPage(safePage - 1);
										}}
									/>
								</PaginationItem>
								{pageWindow(safePage, totalPages).map((p, i) =>
									p === "…" ? (
										<PaginationItem key={`gap-${i}`}>
											<PaginationEllipsis />
										</PaginationItem>
									) : (
										<PaginationItem key={p}>
											<PaginationLink
												isActive={p === safePage}
												aria-label={t.paginationPage(p + 1)}
												onClick={(e) => {
													e.preventDefault();
													setPage(p);
												}}
											>
												{p + 1}
											</PaginationLink>
										</PaginationItem>
									),
								)}
								<PaginationItem>
									<PaginationNext
										text={t.paginationNext}
										aria-disabled={safePage >= totalPages - 1}
										className={
											safePage >= totalPages - 1 ? "pointer-events-none opacity-50" : undefined
										}
										onClick={(e) => {
											e.preventDefault();
											if (safePage < totalPages - 1) setPage(safePage + 1);
										}}
									/>
								</PaginationItem>
							</PaginationContent>
						</Pagination>
					) : null}
				</>
			)}

			<MetricsSection t={t} />

			{configFor !== null && configFor.meta?.config !== undefined ? (
				<ConfigDialog
					plugin={configFor}
					config={states.get(configFor.id)?.config}
					t={t}
					onClose={() => setConfigFor(null)}
				/>
			) : null}

			<AlertDialog
				open={pendingDisable !== null}
				onOpenChange={(open) => !open && setPendingDisable(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t.confirmDisableTitle}</AlertDialogTitle>
						<AlertDialogDescription>{t.confirmDisableBody(pendingNames)}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t.cancel}</AlertDialogCancel>
						<AlertDialogAction onClick={confirmDisable}>{t.confirmDisableAction}</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</PageContainer>
	);
}

function PluginRow({
	plugin,
	enabled,
	missing,
	busy,
	t,
	statusLabel,
	onToggle,
	onConfigure,
}: {
	plugin: Plugin;
	enabled: boolean;
	missing: readonly string[];
	busy: boolean;
	t: ReturnType<typeof managerMessages>;
	statusLabel: (status: RowStatus) => string;
	onToggle: (enabled: boolean) => void;
	onConfigure: () => void;
}) {
	const status: RowStatus = statusOf(enabled, missing);
	// `system: true` manifest plugins (P-062) can never be disabled —
	// the toggle renders locked with a "System" badge and hint.
	const system = plugin.system === true;
	const name = pluginDisplayName(plugin);
	const kinds = contributionKinds(plugin).join(", ");
	return (
		<TableRow>
			<TableCell>
				<div className="font-medium">{name}</div>
				<div className="text-xs text-muted-foreground">
					{plugin.id}
					{plugin.meta?.description ? ` — ${plugin.meta.description}` : ""}
				</div>
			</TableCell>
			<TableCell className="text-muted-foreground">{kinds === "" ? "—" : kinds}</TableCell>
			<TableCell>
				<div className="flex items-center gap-2">
					<Switch
						checked={enabled}
						disabled={system || busy}
						onCheckedChange={onToggle}
						aria-label={name}
					/>
					{system ? (
						<Badge variant="secondary">{t.statusSystem}</Badge>
					) : (
						<Badge variant={status === "enabled" ? "default" : "secondary"}>
							{statusLabel(status)}
						</Badge>
					)}
				</div>
				{system ? <div className="mt-1 text-xs text-muted-foreground">{t.systemHint}</div> : null}
				{missing.length > 0 ? (
					<div className="mt-1 text-xs text-muted-foreground">
						{t.blockedHint(missing.join(", "))}
					</div>
				) : null}
			</TableCell>
			<TableCell className="text-right">
				<DropdownMenu>
					<DropdownMenuTrigger
						render={<Button variant="ghost" size="icon" aria-label={t.rowActions(name)} />}
					>
						<EllipsisVerticalIcon />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						{plugin.meta?.config ? (
							<DropdownMenuItem onClick={onConfigure}>{t.actionConfigure}</DropdownMenuItem>
						) : null}
						<DropdownMenuItem disabled={system || busy} onClick={() => onToggle(!enabled)}>
							{enabled ? t.disable : t.enable}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</TableCell>
		</TableRow>
	);
}

/** `meta.config` editor inside a dialog: generated fields stacked
 * vertically, save state in the footer. Mounted only while open, so
 * field state always initializes from the freshest server config. */
function ConfigDialog({
	plugin,
	config,
	t,
	onClose,
}: {
	plugin: Plugin;
	config: unknown;
	t: ReturnType<typeof managerMessages>;
	onClose: () => void;
}) {
	const schema = plugin.meta?.config;
	/* v8 ignore next -- the caller only mounts this dialog when meta.config exists */
	if (schema === undefined) return null;
	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.configDialogTitle(pluginDisplayName(plugin))}</DialogTitle>
					<DialogDescription>
						{plugin.id}
						{plugin.meta?.description ? ` — ${plugin.meta.description}` : ""}
					</DialogDescription>
				</DialogHeader>
				<ConfigForm pluginId={plugin.id} schema={schema} config={config} t={t} />
			</DialogContent>
		</Dialog>
	);
}

/** Generated settings form for `meta.config` plugins: one labeled
 * control per field (string/number → Input, boolean → Switch, enum →
 * Select), saved through `setPluginConfigFn`. */
function ConfigForm({
	pluginId,
	schema,
	config,
	t,
}: {
	pluginId: string;
	schema: PluginConfigSchema;
	config: unknown;
	t: ReturnType<typeof managerMessages>;
}) {
	const router = useRouter();
	// The JSON-Schema document projects to the flat field list the form
	// renders — derived once per schema (static manifest data).
	const fields = useMemo(() => configFormFields(schema), [schema]);
	const [values, setValues] = useState<Record<string, unknown>>(() =>
		initialFormValues(fields, config),
	);
	const [state, setState] = useState<"idle" | "saving" | "saved" | "failed">("idle");

	// Resync field state when the server config actually changes —
	// router.invalidate() after a save (or an external write) hands the
	// loader fresh entries, but useState alone would keep stale values.
	// Comparing the serialized config keeps unrelated invalidations from
	// clobbering in-progress edits.
	const configJson = JSON.stringify(config ?? null);
	const syncedJson = useRef(configJson);
	useEffect(() => {
		if (syncedJson.current === configJson) return;
		syncedJson.current = configJson;
		setValues(initialFormValues(fields, config));
		setState("idle");
	}, [configJson, config, fields]);

	const set = (key: string, value: unknown) => setValues((v) => ({ ...v, [key]: value }));

	const save = async () => {
		setState("saving");
		try {
			// Load the freshest merged config first so fields the form
			// doesn't render (added by a newer schema) survive the write.
			const current = configObject(await getPluginConfigFn({ data: pluginId }));
			// `undefined` values mean "unset" — drop them so the merge
			// treats the key as absent and the schema default applies
			// (matching validatePluginConfig's missing-key semantics).
			const merged = Object.fromEntries(
				Object.entries({ ...current, ...values }).filter(([, v]) => v !== undefined),
			);
			const ok = await setPluginConfigFn({ data: { pluginId, config: merged } });
			setState(ok ? "saved" : "failed");
			if (ok) await router.invalidate();
		} catch {
			setState("failed");
		}
	};

	return (
		<>
			<div className="space-y-4">
				{fields.map((field) => (
					<div key={field.key} className="space-y-1.5">
						<label className="text-xs font-medium">
							{field.label}
							{field.required ? (
								<span className="text-muted-foreground"> ({t.requiredMark})</span>
							) : null}
						</label>
						{field.type === "boolean" ? (
							<Switch
								checked={values[field.key] === true}
								onCheckedChange={(v) => set(field.key, v)}
								aria-label={field.label}
							/>
						) : field.type === "enum" ? (
							<Select
								items={enumOptions(field).map((opt) => ({ value: opt, label: opt }))}
								value={enumValue(values, field.key)}
								onValueChange={(v) => set(field.key, String(v))}
							>
								<SelectTrigger size="sm" aria-label={field.label} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{enumOptions(field).map((opt) => (
										<SelectItem key={opt} value={opt}>
											{opt}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						) : (
							<Input
								type={field.type === "number" ? "number" : "text"}
								aria-label={field.label}
								value={
									typeof values[field.key] === "string" || typeof values[field.key] === "number"
										? String(values[field.key])
										: ""
								}
								onChange={(e) => {
									const raw = e.target.value;
									if (field.type !== "number") {
										set(field.key, raw);
										return;
									}
									// Empty stays unset (never coerces to 0); a non-finite
									// intermediate (e.g. "1e") keeps the previous value.
									setValues((v) => {
										if (raw === "") return { ...v, [field.key]: undefined };
										const n = Number(raw);
										return { ...v, [field.key]: Number.isFinite(n) ? n : v[field.key] };
									});
								}}
								className="h-8 w-full"
							/>
						)}
					</div>
				))}
			</div>
			<DialogFooter>
				{state === "saved" ? (
					<span className="text-xs text-muted-foreground">{t.configSaved}</span>
				) : null}
				{state === "failed" ? (
					<span className="text-xs text-destructive">{t.configSaveFailed}</span>
				) : null}
				<Button size="sm" disabled={state === "saving"} onClick={() => void save()}>
					{state === "saving" ? <Spinner className="size-3" /> : t.configSave}
				</Button>
			</DialogFooter>
		</>
	);
}
