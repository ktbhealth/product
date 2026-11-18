import { Link } from "@tanstack/react-router";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { ArrowRightIcon, ClipboardListIcon, RadioIcon } from "lucide-react";
import { useContext, type ReactNode } from "react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { ConsultationsDashboardContext } from "../context.ts";
import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { AdminConsultationRow } from "../queries.ts";

const CONSULTATION_TONE: Record<string, string> = {
	live: "bg-warning/10 text-warning ring-warning/20",
	done: "bg-primary/10 text-primary ring-primary/20",
};

const STAT_TONES = {
	consultations: "bg-primary/10 text-primary",
	live: "bg-warning/10 text-warning",
} as const;

/** Grid-cell-sized stat card — same markup the dashboard shell uses for
 * its own stats so contributed cards blend into the grid. */
function StatCard({
	label,
	value,
	icon: Icon,
	tone,
}: {
	label: string;
	value: ReactNode;
	icon: typeof ClipboardListIcon;
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

interface DashboardSlotProps {
	readonly locale?: string;
	readonly i18n?: PageI18nSlice;
}

/**
 * `portal.dashboard.stats` contribution: consultations total + live
 * count. Rows arrive through ConsultationsDashboardContext, which the
 * /platform layout provides from `adminListConsultationsFn` — empty
 * when the package is disabled or the feed was skipped.
 */
export function ConsultationsDashboardStats({ locale = "en", i18n }: DashboardSlotProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const consultations = useContext(ConsultationsDashboardContext);
	const liveCount = consultations.filter((c) => c.status === "live").length;
	return (
		<>
			<StatCard
				icon={ClipboardListIcon}
				tone="consultations"
				label={t.common.consultations}
				value={consultations.length}
			/>
			<StatCard icon={RadioIcon} tone="live" label={t.dashboard.live} value={liveCount} />
		</>
	);
}

/**
 * `portal.dashboard.sections` contribution: by-status/by-source
 * breakdowns plus the most recent consultations table — the domain
 * slice of the console overview the dashboard shell used to own.
 */
export function ConsultationsDashboardSections({ locale = "en", i18n }: DashboardSlotProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const consultations = useContext(ConsultationsDashboardContext);
	const fmtDate = (d: Date) => d.toLocaleString(locale);
	const recent = consultations.slice(0, 8);
	return (
		<>
			<div className="grid gap-4 lg:grid-cols-2">
				<Breakdown
					title={t.dashboard.byStatus}
					rows={groupCount(consultations, (c) => c.status)}
					total={consultations.length}
					empty={t.admin.none}
				/>
				<Breakdown
					title={t.dashboard.bySource}
					rows={groupCount(consultations, (c) => c.source)}
					total={consultations.length}
					empty={t.admin.none}
				/>
			</div>
			<section>
				<SectionTitle
					aside={
						consultations.length > 0 ? (
							<Link to="/platform/consultations" className={viewAllLink}>
								{t.dashboard.viewAll}
								<ArrowRightIcon className="size-3" />
							</Link>
						) : undefined
					}
				>
					{t.dashboard.recentConsultations}
				</SectionTitle>
				{recent.length === 0 ? (
					<p className="mt-2 text-xs text-muted-foreground">{t.admin.none}</p>
				) : (
					<ScrollArea className="mt-2 rounded-lg border border-border [&_[data-slot=table-container]]:overflow-visible">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-12">{t.admin.colId}</TableHead>
									<TableHead>{t.admin.colStatus}</TableHead>
									<TableHead>{t.admin.colSource}</TableHead>
									<TableHead>{t.admin.colOwner}</TableHead>
									<TableHead className="text-right">{t.admin.colCreated}</TableHead>
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
		</>
	);
}
