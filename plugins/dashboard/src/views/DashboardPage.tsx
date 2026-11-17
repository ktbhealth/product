import { Link } from "@tanstack/react-router";
import { sliceMessages } from "@ktb/i18n";
import { collectChrome } from "@ktb/kernel";
import type { PageContext, PageI18nSlice, Plugin } from "@ktb/kernel";
import type { PluginStateEntry } from "@ktb/platform/plugin-states";
import { ArrowRightIcon, PuzzleIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { dashboardMessages, I18N_NAMESPACE } from "../i18n.ts";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Card, CardContent, CardHeader } from "@ktbhealth/ui/components/card";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";

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

const STAT_TONES = {
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
	icon: typeof PuzzleIcon;
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

/**
 * /platform landing view — a generic console shell (T-125): the plugins
 * stat, the registered-plugins card with runtime enable-state, and two
 * chrome slot regions. Domain content (patients, consultations,
 * notifications) is NOT owned here — each domain plugin contributes
 * `chrome` entries to "portal.dashboard.stats" (extra cells in the stat
 * grid — each must render a grid-cell-sized card) and
 * "portal.dashboard.sections" (full-width sections appended at the
 * bottom), fed by contexts the /platform layout provides. Disabled
 * plugins' entries are filtered out, matching the sidebar/header chrome
 * behavior.
 */
export function DashboardPage({
	plugins,
	pluginStates,
	i18n,
	locale = "en",
	user,
}: {
	plugins: readonly Plugin[];
	/** Runtime enable-state per plugin id (P-058); `undefined` means the
	 * state service was unavailable — every plugin then renders as
	 * enabled, matching the absence=enabled default. */
	pluginStates?: readonly PluginStateEntry[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Session user, injected by the host via the panel page ctx. */
	user?: PageContext["user"];
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, dashboardMessages(locale));
	const stateById = new Map((pluginStates ?? []).map((s) => [s.pluginId, s] as const));
	const pluginState = (id: string): "enabled" | "disabled" | "system" => {
		const entry = stateById.get(id);
		if (entry?.system === true) return "system";
		return entry?.enabled === false ? "disabled" : "enabled";
	};
	const enabledCount = plugins.filter((p) => pluginState(p.id) !== "disabled").length;
	// Dashboard chrome slots: slot components receive the panel page ctx
	// (`PageContext` — plugins, locale, user, i18n), not the full
	// `ChromeProps`; the dashboard page is the slot's shell.
	const pageCtx: PageContext = { plugins, locale, user, i18n };
	const slotComponents = (region: string) =>
		collectChrome(
			plugins.filter((p) => pluginState(p.id) !== "disabled"),
			region,
			"/platform",
			"platform",
			user,
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
				<Stat
					icon={PuzzleIcon}
					tone="plugins"
					label={t.stats.plugins}
					value={`${enabledCount}/${plugins.length}`}
				/>
				{slotComponents("portal.dashboard.stats")}
			</div>

			<div className="grid gap-4 lg:grid-cols-3">
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

			{slotComponents("portal.dashboard.sections")}
		</PageContainer>
	);
}
