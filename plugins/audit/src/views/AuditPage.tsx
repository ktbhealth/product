import { useMemo, useState } from "react";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import type { AdminAuditRow } from "../index.ts";
import { auditMessages, type AuditMessages } from "../i18n.ts";

const SEARCH_CLS = "w-56 sm:w-64";

const fmtDate = (value: Date | string, locale: string): string => {
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale);
};

/** Action group = first dot segment ("users.suspend" → "users"). */
const actionGroup = (action: string): string => {
	const dot = action.indexOf(".");
	return dot === -1 ? action : action.slice(0, dot);
};

const parseDetail = (raw: string | null): unknown => {
	/* v8 ignore next -- the JSON button only renders for non-null detail */
	if (raw === null) return null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
};

const targetLabel = (row: AdminAuditRow): string =>
	[row.targetType, row.targetId].filter((v) => v !== null && v !== "").join(":") || "";

/** Actor filter key — mirrors the actor cell's fallback chain. */
const actorKey = (row: AdminAuditRow): string => row.actorEmail ?? row.actorUserId ?? "system";

/** Target-type filter key; null columns bucket under this sentinel. */
const NO_TARGET_TYPE = "none";
const targetTypeKey = (row: AdminAuditRow): string => row.targetType ?? NO_TARGET_TYPE;

/**
 * Shared audit listing — /platform/audit (T-037, platform admin log)
 * and /portal/clinician/activity (P-080, tenant-scoped staff feed).
 * Rows arrive newest-first, already capped server-side; search and the
 * action-group/actor/target-type filters run client-side over that
 * window. Detail JSON is shown in a dialog — ids and non-sensitive
 * params only, by contract.
 * Dense/utilitarian by design (system console).
 */
export function AuditPage({
	entries,
	total,
	locale = "en",
	title,
}: {
	entries: readonly AdminAuditRow[];
	/** Total rows in the log (may exceed the capped page). */
	total: number;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
	/** Page heading override — the staff activity feed (P-080) passes
	 * its own title; defaults to the console's "Audit log" copy. */
	title?: string;
}) {
	const t = auditMessages(locale);
	const [q, setQ] = useState("");
	// "all" sentinel — Base UI Select items reject empty-string values.
	const [group, setGroup] = useState("all");
	const [actor, setActor] = useState("all");
	const [targetType, setTargetType] = useState("all");
	const [detailFor, setDetailFor] = useState<AdminAuditRow | null>(null);

	const groups = useMemo(
		() => [...new Set(entries.map((e) => actionGroup(e.action)))].sort(),
		[entries],
	);
	const actors = useMemo(() => [...new Set(entries.map(actorKey))].sort(), [entries]);
	const targetTypes = useMemo(() => [...new Set(entries.map(targetTypeKey))].sort(), [entries]);
	const needle = q.trim().toLowerCase();
	const shown = useMemo(() => {
		return entries.filter(
			(e) => {
				if (group !== "all" && actionGroup(e.action) !== group) return false;
				if (actor !== "all" && actorKey(e) !== actor) return false;
				if (targetType !== "all" && targetTypeKey(e) !== targetType) return false;
				if (needle === "") return true;
				return [e.actorEmail ?? "", e.actorUserId ?? "", e.action, e.targetId ?? "", e.detail ?? ""]
					.join(" ")
					.toLowerCase()
					.includes(needle);
			},
			[entries, group, actor, targetType, needle],
		);
	}, [entries, group, actor, targetType, needle]);

	return (
		<PageContainer>
			<PageHeader title={title ?? t.title} description={t.description(entries.length, total)} />
			{entries.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.emptyTitle}</EmptyTitle>
						<EmptyDescription>{t.emptyDescription}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<DataToolbar
						search={
							<Input
								type="search"
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder={t.searchPlaceholder}
								aria-label={t.searchLabel}
								className={SEARCH_CLS}
							/>
						}
						filters={
							<>
								<Select value={group} onValueChange={(v) => setGroup(String(v))}>
									<SelectTrigger className="h-8 w-40 text-xs" aria-label={t.allActions}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.allActions}</SelectItem>
										{groups.map((g) => (
											<SelectItem key={g} value={g}>
												{g}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select value={actor} onValueChange={(v) => setActor(String(v))}>
									<SelectTrigger className="h-8 w-44 text-xs" aria-label={t.allActors}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.allActors}</SelectItem>
										{actors.map((a) => (
											<SelectItem key={a} value={a}>
												{a === "system" ? t.systemActor : a}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Select value={targetType} onValueChange={(v) => setTargetType(String(v))}>
									<SelectTrigger className="h-8 w-40 text-xs" aria-label={t.allTargetTypes}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="all">{t.allTargetTypes}</SelectItem>
										{targetTypes.map((tt) => (
											<SelectItem key={tt} value={tt}>
												{tt === NO_TARGET_TYPE ? t.noTargetType : tt}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</>
						}
						resultCount={
							needle === "" && group === "all" && actor === "all" && targetType === "all"
								? undefined
								: t.filteredCount(shown.length, entries.length)
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-44">{t.colTime}</TableHead>
									<TableHead>{t.colActor}</TableHead>
									<TableHead>{t.colAction}</TableHead>
									<TableHead>{t.colTarget}</TableHead>
									<TableHead>{t.colTenant}</TableHead>
									<TableHead className="text-right">{t.colDetail}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{shown.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="text-xs text-muted-foreground">
											{t.noMatch}
										</TableCell>
									</TableRow>
								) : (
									shown.map((row) => (
										<TableRow key={row.id}>
											<TableCell className="text-xs text-muted-foreground">
												{fmtDate(row.createdAt, locale)}
											</TableCell>
											<TableCell className="text-xs">
												{row.actorEmail ?? row.actorUserId ?? t.systemActor}
											</TableCell>
											<TableCell className="font-mono text-xs">{row.action}</TableCell>
											<TableCell className="max-w-52 truncate text-xs">
												{targetLabel(row) || t.noTarget}
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{row.tenantId === null ? t.noTenant : `#${row.tenantId}`}
											</TableCell>
											<TableCell className="text-right">
												{row.detail !== null ? (
													<Button
														type="button"
														variant="ghost"
														size="sm"
														onClick={() => setDetailFor(row)}
													>
														JSON
													</Button>
												) : null}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</>
			)}
			{detailFor !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						/* v8 ignore next -- mounted only while detailFor; only close events fire */
						if (!open) setDetailFor(null);
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t.detailTitle}</DialogTitle>
							<DialogDescription className="font-mono text-xs">
								{detailFor.action}
							</DialogDescription>
						</DialogHeader>
						<pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
							{JSON.stringify(parseDetail(detailFor.detail), null, 2)}
						</pre>
					</DialogContent>
				</Dialog>
			) : null}
		</PageContainer>
	);
}
