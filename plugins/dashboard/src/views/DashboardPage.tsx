import { Link } from "@tanstack/react-router";
import type { AdminConsultationRow } from "@ktb/consultations";
import { collectChrome } from "@ktb/kernel";
import type { PageContext, Plugin } from "@ktb/kernel";
import type { ConsoleNotification } from "@ktb/notifications/context";
import type { AdminPatientRow } from "@ktb/patients";
import type { PluginStateEntry } from "@ktb/platform/plugin-states";
import { ArrowRightIcon, ClipboardListIcon, PuzzleIcon, RadioIcon, UsersIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { dashboardMessages } from "../i18n.ts";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

const contributions = (p: Plugin) =>
	[
		p.routes?.length ? "routes" : null,
		p.chrome?.length ? "chrome" : null,
		p.landing ? "landing" : null,
		p.panel?.pages?.length ? "panel" : null,
		p.tables !== undefined ? "tables" : null,
		p.services !== undefined ? "services" : null,
	]
		.filter(Boolean)
		.join(", ") || "—";

const STATE_BADGE: Record<string, string> = {
	enabled: "bg-primary/10 text-primary ring-1 ring-primary/20",
	disabled: "bg-muted text-muted-foreground ring-1 ring-border",
	system: "bg-amber-50 text-amber-700 ring-1 ring-amber-200",
};

const CONSULTATION_TONE: Record<string, string> = {
	live: "bg-amber-50 text-amber-700 ring-amber-200",
	done: "bg-primary/10 text-primary ring-primary/20",
};

const STAT_TONES = {
	users: "bg-sky-500/10 text-sky-600",
	consultations: "bg-primary/10 text-primary",
	live: "bg-amber-500/10 text-amber-600",
	plugins: "bg-violet-500/10 text-violet-600",
} as const;

function Stat({
	label,
	value,
	icon: Icon,
	tone,
}: {
	label: string;
	value: ReactNode;
	icon: typeof UsersIcon;
	tone: keyof typeof STAT_TONES;
}) {
	return (
		<Card>
			<CardContent className="flex items-center gap-3 px-4 py-3">
				<span
					className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${STAT_TONES[tone]}`}
				>
					<Icon className="size-4" />
				</span>
				<div className="min-w-0">
					<div className="text-[10px] tracking-widest text-muted-foreground uppercase">{label}</div>
					<div className="truncate text-xl font-bold">{value}</div>
				</div>
			</CardContent>
		</Card>
	);
}

function SectionTitle({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
	return (
		<div className="flex items-center justify-between gap-2">
			<h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
				{children}
			</h2>
			{aside}
		</div>
	);
}

const viewAllLink =
	"inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground";

function Breakdown({
	title,
	rows,
	total,
	empty,
}: {
	title: string;
	rows: readonly { label: string; count: number }[];
	total: number;
	empty: string;
}) {
	return (
		<Card>
			<CardHeader className="pb-2">
				<CardTitle className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>
				{rows.length === 0 ? (
					<p className="text-xs text-muted-foreground">{empty}</p>
				) : (
					<ul className="space-y-2.5">
						{rows.map((row) => (
							<li key={row.label}>
								<div className="flex items-baseline justify-between text-xs">
									<span className="font-medium">{row.label}</span>
									<span className="text-muted-foreground tabular-nums">
										{row.count}
										<span className="text-muted-foreground/60">
											{" "}
											({Math.round((row.count / Math.max(total, 1)) * 100)}%)
										</span>
									</span>
								</div>
								<div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
									<div
										className="h-full rounded-full bg-primary"
										style={{ width: `${(row.count / Math.max(total, 1)) * 100}%` }}
									/>
								</div>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
}

const groupCount = (
	rows: readonly AdminConsultationRow[],
	key: (c: AdminConsultationRow) => string,
): { label: string; count: number }[] => {
	const counts = new Map<string, number>();
	for (const c of rows) counts.set(key(c), (counts.get(key(c)) ?? 0) + 1);
	return [...counts.entries()]
		.map(([label, count]) => ({ label, count }))
		.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
};

/**
 * /platform landing view — system overview for platform admins: headline
 * counts, consultation breakdowns, the plugin registry with runtime
 * enable-state, and (when the notifications backend is registered) a
 * console-activity card with the unread count and the caller's most
 * recent notifications. Dense by design.
 */
export function DashboardPage({
	patients,
	consultations,
	plugins,
	pluginStates,
	notifications,
	unreadCount = 0,
	locale = "en",
	user,
}: {
	patients: AdminPatientRow[];
	consultations: AdminConsultationRow[];
	plugins: readonly Plugin[];
	/** Runtime enable-state per plugin id (P-058); `undefined` means the
	 * state service was unavailable — every plugin then renders as
	 * enabled, matching the absence=enabled default. */
	pluginStates?: readonly PluginStateEntry[];
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Session user, injected by the host via the panel page ctx. */
	user?: PageContext["user"];
	/** Session user's recent notifications — `undefined` hides the
	 * console-activity card entirely (backend plugin not registered). */
	notifications?: readonly ConsoleNotification[];
	unreadCount?: number;
}) {
	const t = dashboardMessages(locale);
	const fmtDate = (d: Date) => d.toLocaleString(locale);
	const recent = consultations.slice(0, 8);
	const liveCount = consultations.filter((c) => c.status === "live").length;
	const stateById = new Map((pluginStates ?? []).map((s) => [s.pluginId, s] as const));
	const pluginState = (id: string): "enabled" | "disabled" | "system" => {
		const entry = stateById.get(id);
		if (entry?.system === true) return "system";
		return entry?.enabled === false ? "disabled" : "enabled";
	};
	const enabledCount = plugins.filter((p) => pluginState(p.id) !== "disabled").length;
	// Dashboard chrome slots: other plugins contribute `chrome` entries to
	// "portal.dashboard.stats" (extra cells in the stat grid — each must
	// render a grid-cell-sized card) and "portal.dashboard.sections"
	// (full-width sections appended at the bottom). Components receive the
	// panel page ctx (`PageContext`), not the full `ChromeProps` — the
	// dashboard page is the slot's shell. Disabled plugins' entries are
	// filtered out, matching the sidebar/header chrome behavior.
	const pageCtx: PageContext = { plugins, locale, user };
	const slotComponents = (region: string) =>
		collectChrome(
			plugins.filter((p) => pluginState(p.id) !== "disabled"),
			region,
			"/platform",
			"platform",
		).flatMap((entry) => {
			if (entry.content.kind !== "component") return [];
			const C = entry.content.component as ComponentType<PageContext>;
			return [<C key={entry.id} {...pageCtx} />];
		});
	const stateLabel = (id: string) =>
		pluginState(id) === "system"
			? t.stateSystem
			: pluginState(id) === "disabled"
				? t.stateDisabled
				: t.stateEnabled;
	return (
		<PageContainer>
			<PageHeader title={t.title} description={t.subtitle} />

			<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
				<Stat icon={UsersIcon} tone="users" label={t.stats.patients} value={patients.length} />
				<Stat
					icon={ClipboardListIcon}
					tone="consultations"
					label={t.stats.consultations}
					value={consultations.length}
				/>
				<Stat icon={RadioIcon} tone="live" label={t.stats.live} value={liveCount} />
				<Stat
					icon={PuzzleIcon}
					tone="plugins"
					label={t.stats.plugins}
					value={`${enabledCount}/${plugins.length}`}
				/>
				{slotComponents("portal.dashboard.stats")}
			</div>

			<div className="grid gap-4 lg:grid-cols-3">
				<Breakdown
					title={t.byStatus}
					rows={groupCount(consultations, (c) => c.status)}
					total={consultations.length}
					empty={t.noConsultations}
				/>
				<Breakdown
					title={t.bySource}
					rows={groupCount(consultations, (c) => c.source)}
					total={consultations.length}
					empty={t.noConsultations}
				/>
				<Card>
					<CardHeader className="pb-2">
						<SectionTitle
							aside={
								<Link to="/platform/plugins" className={viewAllLink}>
									{t.managePlugins}
									<ArrowRightIcon className="size-3" />
								</Link>
							}
						>
							{t.registeredPlugins}
						</SectionTitle>
					</CardHeader>
					<CardContent>
						<div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full rounded-full bg-primary"
								style={{
									width: `${plugins.length === 0 ? 0 : (enabledCount / plugins.length) * 100}%`,
								}}
							/>
						</div>
						<p className="mb-2 text-xs text-muted-foreground">
							{enabledCount}/{plugins.length} {t.stateEnabled.toLowerCase()}
						</p>
						<ScrollArea className="h-56">
							<ul className="space-y-1 pr-2">
								{plugins.map((p) => {
									const state = pluginState(p.id);
									return (
										<li key={p.id} className="flex items-center gap-2 text-xs">
											<Badge variant="secondary" className={`shrink-0 ${STATE_BADGE[state]}`}>
												{stateLabel(p.id)}
											</Badge>
											<span className="truncate font-medium">{p.id}</span>
											<span className="truncate text-muted-foreground/70">{contributions(p)}</span>
										</li>
									);
								})}
							</ul>
						</ScrollArea>
					</CardContent>
				</Card>
			</div>

			<div className="grid gap-6 lg:grid-cols-2">
				<section>
					<SectionTitle
						aside={
							consultations.length > 0 ? (
								<Link to="/platform/consultations" className={viewAllLink}>
									{t.viewAll}
									<ArrowRightIcon className="size-3" />
								</Link>
							) : undefined
						}
					>
						{t.recentConsultations}
					</SectionTitle>
					{recent.length === 0 ? (
						<p className="mt-2 text-xs text-muted-foreground">{t.noConsultations}</p>
					) : (
						<ScrollArea className="mt-2 rounded-lg border border-border [&_[data-slot=table-container]]:overflow-visible">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead className="w-12">{t.colId}</TableHead>
										<TableHead>{t.colStatus}</TableHead>
										<TableHead>{t.colSource}</TableHead>
										<TableHead>{t.colOwner}</TableHead>
										<TableHead className="text-right">{t.colCreated}</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{recent.map((c) => (
										<TableRow key={c.id}>
											<TableCell className="text-xs text-muted-foreground">{c.id}</TableCell>
											<TableCell>
												<Badge
													variant="secondary"
													className={`ring-1 ${CONSULTATION_TONE[c.status] ?? CONSULTATION_TONE.done}`}
												>
													{c.status}
												</Badge>
											</TableCell>
											<TableCell className="text-muted-foreground">{c.source}</TableCell>
											<TableCell className="max-w-0">
												<span className="block truncate">{c.ownerName ?? c.ownerEmail ?? "—"}</span>
											</TableCell>
											<TableCell
												className="text-right whitespace-nowrap text-muted-foreground"
												// SSR renders in the server's timezone, the client
												// in the browser's — suppress the text mismatch.
												suppressHydrationWarning
											>
												{fmtDate(c.createdAt)}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</ScrollArea>
					)}
				</section>

				{notifications !== undefined ? (
					<section>
						<SectionTitle>{t.consoleActivity}</SectionTitle>
						<div className="mt-2 rounded-lg border border-border px-3 py-2.5">
							<div className="flex items-baseline justify-between">
								<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
									{t.unreadNotifications}
								</span>
								<span className="text-lg font-bold">{unreadCount}</span>
							</div>
							{notifications.length === 0 ? (
								<p className="mt-2 text-xs text-muted-foreground">{t.noNotifications}</p>
							) : (
								<ul className="mt-1 divide-y divide-border">
									{notifications.slice(0, 5).map((n) => (
										<li key={n.id} className="flex gap-2.5 py-2">
											<span
												className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
													n.read ? "bg-transparent" : "bg-primary"
												}`}
											/>
											<div className="min-w-0">
												<p className="truncate text-sm">{n.title}</p>
												{n.description ? (
													<p className="truncate text-xs text-muted-foreground">{n.description}</p>
												) : null}
												{n.meta ? (
													<p className="mt-0.5 text-[11px] text-muted-foreground/70">{n.meta}</p>
												) : null}
											</div>
										</li>
									))}
								</ul>
							)}
						</div>
					</section>
				) : null}
			</div>

			{slotComponents("portal.dashboard.sections")}
		</PageContainer>
	);
}
