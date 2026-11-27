import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { JobRecord } from "@ktb/jobs-port";
import type { ScheduleEntryInfo, SchedulableKindInfo } from "@ktb/server-fns";
import { Button } from "@ktbhealth/ui/components/button";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { JobStatus as JobStatusBadge } from "@ktbhealth/ui/components/job-status";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import {
	createScheduleFn,
	deleteScheduleFn,
	runCronJobFn,
	runScheduleFn,
	updateScheduleFn,
} from "../fns.ts";
import { cronMessages, I18N_NAMESPACE, type CronMessages } from "../i18n.ts";
import type { CronRunNowResult } from "../admin.ts";

/**
 * /platform/cron — the Concurrency console page. Two tabs: "Schedules"
 * (the unified read model — deploy-time cron registry jobs AND runtime
 * scheduled_jobs rows in one table, each row carrying its source) and
 * "Run history" (the `cron.*` job_runs projection feed). Run-now fires
 * the same path the worker's `scheduled` handler / scheduler sweep
 * uses; pause/resume/delete apply to runtime rows only.
 */

interface CronPageProps {
	readonly runs: readonly JobRecord[] | null;
	readonly entries: readonly ScheduleEntryInfo[] | null;
	readonly scheduleKinds?: readonly string[] | null;
	readonly schedulableKinds?: readonly SchedulableKindInfo[] | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	readonly i18n?: PageI18nSlice;
	readonly locale: string;
}

const fmt = (ts: number | string | null | undefined, locale: string) =>
	ts === null || ts === undefined
		? "—"
		: new Date(ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" });

const Unavailable = ({ m }: { m: CronMessages }) => (
	<div className="border-border rounded-md border px-4 py-6 text-sm">
		<span className="font-medium">{m.unavailableTitle}</span>
		<span className="text-muted-foreground"> — {m.unavailableDescription}</span>
	</div>
);

const runNowMessage = (result: CronRunNowResult, m: CronMessages): string => {
	if (result.ok) return result.summary === undefined ? m.runOkNoSummary : m.runOk(result.summary);
	switch (result.reason) {
		case "unknown-job":
			return m.runUnknown;
		case "unavailable":
			return m.runUnavailable;
		case "forbidden":
			return m.runForbidden;
		default:
			return result.error === undefined ? m.runFailed : `${m.runFailed} ${result.error}`;
	}
};

function RunsSection({
	runs,
	locale,
	m,
}: {
	runs: readonly JobRecord[] | null;
	locale: string;
	m: CronMessages;
}) {
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.runsTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.runsDescription}</p>
			{runs === null ? (
				<Unavailable m={m} />
			) : runs.length === 0 ? (
				<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
					{m.emptyRunsTitle} — {m.emptyRunsDescription}
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.rColId}</TableHead>
							<TableHead>{m.rColJob}</TableHead>
							<TableHead>{m.rColStatus}</TableHead>
							<TableHead>{m.rColError}</TableHead>
							<TableHead>{m.rColStarted}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{runs.map((r) => (
							<TableRow key={r.id}>
								<TableCell className="font-mono text-xs">{r.id.slice(0, 8)}</TableCell>
								<TableCell className="font-medium">{r.kind.replace(/^cron\./, "")}</TableCell>
								<TableCell>
									<JobStatusBadge status={r.status} />
								</TableCell>
								<TableCell className="max-w-48 truncate text-xs" title={r.error ?? ""}>
									{r.error ?? "—"}
								</TableCell>
								<TableCell className="text-xs whitespace-nowrap">
									{fmt(r.createdAt, locale)}
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

type ScheduleAction = "create" | "pause" | "resume" | "delete" | "run";

const statusLabel = (status: ScheduleEntryInfo["status"], m: CronMessages) =>
	status === "active" ? m.statusActive : status === "paused" ? m.statusPaused : m.statusDone;

const sourceLabel = (source: ScheduleEntryInfo["source"], m: CronMessages) =>
	source === "cron" ? m.sourceCron : m.sourceRuntime;

/** Last-run cell: cron registry entries carry the joined job_runs slice
 * (ok/failed/running + error); scheduled rows only have lastRunAt. */
const LastRunCell = ({
	entry,
	locale,
	m,
}: {
	entry: ScheduleEntryInfo;
	locale: string;
	m: CronMessages;
}) => {
	if (entry.lastRun !== null) {
		const run = entry.lastRun;
		return (
			<span className="flex flex-col">
				<span
					className={
						run.running ? "text-muted-foreground" : run.ok ? "text-success" : "text-destructive"
					}
				>
					{run.running ? m.lastRunning : run.ok ? m.lastOk : m.lastFailed}
				</span>
				<span className="text-muted-foreground">{fmt(run.at, locale)}</span>
				{run.error !== null && (
					<span className="text-destructive max-w-48 truncate" title={run.error}>
						{run.error}
					</span>
				)}
			</span>
		);
	}
	if (entry.lastRunAt !== null)
		return <span className="text-xs">{fmt(entry.lastRunAt, locale)}</span>;
	return <span className="text-muted-foreground text-xs">{m.neverRan}</span>;
};

function SchedulesSection({
	entries,
	kinds,
	schedulable = null,
	locale,
	m,
}: {
	entries: readonly ScheduleEntryInfo[] | null;
	kinds: readonly string[] | null;
	schedulable?: readonly SchedulableKindInfo[] | null;
	locale: string;
	m: CronMessages;
}) {
	const router = useRouter();
	const [kind, setKind] = useState("");
	const [mode, setMode] = useState<"cron" | "once">("cron");
	const [cronExpr, setCronExpr] = useState("");
	const [runAt, setRunAt] = useState("");
	const [paramsRaw, setParamsRaw] = useState("");
	const [busy, setBusy] = useState<ScheduleAction | null>(null);
	const [rowBusy, setRowBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);
	// Per-entry run-now state — several rows can report independently
	// (the old jobs table kept per-id state for the same reason) and a
	// pending run must not disable sibling rows' buttons.
	const [runStates, setRunStates] = useState<
		Record<string, { pending: boolean; text: string; ok: boolean }>
	>({});

	const say = (text: string, ok: boolean) => setMessage({ text, ok });
	const refresh = () => void router.invalidate();

	// jobs.schedulable declarations: first entry per kind wins the
	// picker label/suggestions (multiple presets per kind are legal).
	const schedulableByKind = new Map<string, SchedulableKindInfo>();
	for (const decl of schedulable ?? []) {
		if (!schedulableByKind.has(decl.kind)) schedulableByKind.set(decl.kind, decl);
	}
	const kindOptions = [...new Set([...(kinds ?? []), ...schedulableByKind.keys()])].sort();

	const onKindChange = (value: string) => {
		setKind(value);
		const decl = schedulableByKind.get(value.trim());
		if (decl === undefined) return;
		if (decl.suggestedCronExpr !== undefined && cronExpr === "") {
			setCronExpr(decl.suggestedCronExpr);
		}
		if (decl.suggestedParams !== undefined && decl.suggestedParams !== null && paramsRaw === "") {
			setParamsRaw(JSON.stringify(decl.suggestedParams));
		}
	};

	const submitCreate = async () => {
		setBusy("create");
		setMessage(null);
		let params: unknown;
		if (paramsRaw.trim() !== "") {
			try {
				params = JSON.parse(paramsRaw) as unknown;
			} catch {
				setBusy(null);
				say(m.schedInvalid, false);
				return;
			}
		}
		const runAtMs = mode === "once" && runAt !== "" ? new Date(runAt).getTime() : null;
		try {
			const result = await createScheduleFn({
				data: {
					kind: kind.trim(),
					...(params !== undefined ? { params } : {}),
					cronExpr: mode === "cron" ? cronExpr.trim() : null,
					runAt: runAtMs,
				},
			});
			setBusy(null);
			if (result.ok) {
				say(m.schedCreated, true);
				setKind("");
				setCronExpr("");
				setRunAt("");
				setParamsRaw("");
				refresh();
			} else {
				say(result.reason === "invalid" ? m.schedInvalid : m.schedFailed, false);
			}
		} catch {
			setBusy(null);
			say(m.schedFailed, false);
		}
	};

	const act = async (entry: ScheduleEntryInfo, action: "pause" | "resume" | "delete" | "run") => {
		if (action === "run") {
			// Both sources share the CronRunNowResult shape — the source
			// picks which fire path the id addresses. Own try/catch so a
			// rejection lands on this row's state, not the shared message.
			setRunStates((s) => ({ ...s, [entry.id]: { pending: true, text: "", ok: false } }));
			setMessage(null);
			try {
				const result =
					entry.source === "cron"
						? await runCronJobFn({ data: { id: entry.refId } })
						: await runScheduleFn({ data: { id: entry.refId } });
				setRunStates((s) => ({
					...s,
					[entry.id]: { pending: false, text: runNowMessage(result, m), ok: result.ok },
				}));
				refresh();
			} catch {
				setRunStates((s) => ({
					...s,
					[entry.id]: {
						pending: false,
						text: entry.source === "cron" ? m.runFailed : m.schedFailed,
						ok: false,
					},
				}));
			}
			return;
		}
		setRowBusy(`${action}:${entry.id}`);
		setMessage(null);
		try {
			if (action === "delete") {
				const result = await deleteScheduleFn({ data: { id: entry.refId } });
				setRowBusy(null);
				if (result.ok) {
					say(m.schedDeleted, true);
					refresh();
				} else {
					say(m.schedFailed, false);
				}
				return;
			}
			const result = await updateScheduleFn({
				data: {
					id: entry.refId,
					patch: { status: action === "pause" ? "paused" : "active" },
				},
			});
			setRowBusy(null);
			if (result.ok) {
				say(m.schedUpdated, true);
				refresh();
			} else {
				say(result.reason === "invalid" ? m.schedInvalid : m.schedFailed, false);
			}
		} catch {
			setRowBusy(null);
			say(m.schedFailed, false);
		}
	};

	return (
		<section>
			<h2 className="text-sm font-semibold">{m.schedulesTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.schedulesDescription}</p>
			{entries === null ? (
				<Unavailable m={m} />
			) : (
				<>
					{entries.length === 0 ? (
						<div className="border-border text-muted-foreground mb-4 rounded-md border px-4 py-6 text-sm">
							{m.emptySchedulesTitle} — {m.emptySchedulesDescription}
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{m.eColName}</TableHead>
									<TableHead>{m.eColSource}</TableHead>
									<TableHead>{m.eColTriggers}</TableHead>
									<TableHead>{m.eColDescription}</TableHead>
									<TableHead>{m.sColNextRun}</TableHead>
									<TableHead>{m.sColLastRun}</TableHead>
									<TableHead>{m.sColStatus}</TableHead>
									<TableHead className="text-right">{m.sColAction}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{entries.map((entry) => (
									<TableRow key={entry.id}>
										<TableCell className="font-medium">{entry.name}</TableCell>
										<TableCell>
											<span className="text-muted-foreground text-xs">
												{sourceLabel(entry.source, m)}
											</span>
										</TableCell>
										<TableCell>
											<div className="flex flex-col gap-0.5">
												{entry.cronExprs.map((expr) => (
													<code key={expr} className="text-xs">
														{expr}
													</code>
												))}
												{entry.runAt !== null && entry.cronExprs.length === 0 && (
													<span className="text-xs">{fmt(entry.runAt, locale)}</span>
												)}
												{entry.cronExprs.length === 0 && entry.runAt === null && (
													<span className="text-muted-foreground text-xs">—</span>
												)}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground max-w-64 text-xs">
											{entry.description ?? "—"}
										</TableCell>
										<TableCell className="text-xs whitespace-nowrap">
											{entry.nextRunAt === null ? (
												<span className="text-muted-foreground">—</span>
											) : (
												fmt(entry.nextRunAt, locale)
											)}
										</TableCell>
										<TableCell className="text-xs whitespace-nowrap">
											<LastRunCell entry={entry} locale={locale} m={m} />
										</TableCell>
										<TableCell>
											<span
												className={
													entry.status === "active" ? "text-success" : "text-muted-foreground"
												}
											>
												{statusLabel(entry.status, m)}
											</span>
										</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-1">
												{/* Run now: cron registry jobs always;
												 * scheduled rows only while active —
												 * runScheduledJobNow claims active rows
												 * only, so paused/done would 404. */}
												{(entry.source === "cron" || entry.status === "active") && (
													<Button
														size="sm"
														variant="outline"
														disabled={runStates[entry.id]?.pending === true}
														onClick={() => void act(entry, "run")}
													>
														{runStates[entry.id]?.pending === true ? m.running : m.runNow}
													</Button>
												)}
												{entry.mutable && entry.status === "active" && (
													<Button
														size="sm"
														variant="outline"
														disabled={rowBusy !== null}
														onClick={() => void act(entry, "pause")}
													>
														{m.actPause}
													</Button>
												)}
												{entry.mutable && entry.status === "paused" && (
													<Button
														size="sm"
														variant="outline"
														disabled={rowBusy !== null}
														onClick={() => void act(entry, "resume")}
													>
														{m.actResume}
													</Button>
												)}
												{entry.mutable && (
													<Button
														size="sm"
														variant="outline"
														disabled={rowBusy !== null}
														onClick={() => void act(entry, "delete")}
													>
														{m.actDelete}
													</Button>
												)}
											</div>
											{runStates[entry.id] !== undefined &&
												runStates[entry.id]!.pending !== true && (
													<p
														className={`mt-1 text-xs ${runStates[entry.id]!.ok ? "text-success" : "text-destructive"}`}
													>
														{runStates[entry.id]!.text}
													</p>
												)}
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
					{message !== null && (
						<p className={`mt-2 text-xs ${message.ok ? "text-success" : "text-destructive"}`}>
							{message.text}
						</p>
					)}
					<div className="border-border mt-4 max-w-2xl rounded-md border p-4">
						<h3 className="text-sm font-semibold">{m.newScheduleTitle}</h3>
						<div className="mt-3 grid gap-3">
							<Field>
								<FieldLabel htmlFor="sched-kind">{m.fKind}</FieldLabel>
								<Input
									id="sched-kind"
									list="sched-kinds"
									value={kind}
									onChange={(e) => onKindChange(e.target.value)}
									placeholder={m.fKindPlaceholder}
								/>
								<datalist id="sched-kinds">
									{kindOptions.map((k) => {
										const decl = schedulableByKind.get(k);
										return (
											<option key={k} value={k}>
												{decl?.description ?? k}
											</option>
										);
									})}
								</datalist>
							</Field>
							<Field>
								<FieldLabel>{m.fModeRecurring}</FieldLabel>
								<Select value={mode} onValueChange={(v) => setMode(v === "once" ? "once" : "cron")}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="cron">{m.fModeRecurring}</SelectItem>
										<SelectItem value="once">{m.fModeOnce}</SelectItem>
									</SelectContent>
								</Select>
							</Field>
							{mode === "cron" ? (
								<Field>
									<FieldLabel htmlFor="sched-cron">{m.fCronExpr}</FieldLabel>
									<Input
										id="sched-cron"
										value={cronExpr}
										onChange={(e) => setCronExpr(e.target.value)}
										placeholder={m.fCronExprPlaceholder}
									/>
								</Field>
							) : (
								<Field>
									<FieldLabel htmlFor="sched-runat">{m.fRunAt}</FieldLabel>
									<Input
										id="sched-runat"
										type="datetime-local"
										value={runAt}
										onChange={(e) => setRunAt(e.target.value)}
									/>
								</Field>
							)}
							<Field>
								<FieldLabel htmlFor="sched-params">{m.fParams}</FieldLabel>
								<Textarea
									id="sched-params"
									value={paramsRaw}
									onChange={(e) => setParamsRaw(e.target.value)}
									placeholder={m.fParamsPlaceholder}
									rows={2}
								/>
							</Field>
							<div className="flex items-center gap-3">
								<Button
									size="sm"
									disabled={busy !== null || kind.trim() === ""}
									onClick={() => void submitCreate()}
								>
									{busy === "create" ? m.fCreating : m.fCreate}
								</Button>
							</div>
						</div>
					</div>
				</>
			)}
		</section>
	);
}

export function CronPage({
	runs,
	entries,
	scheduleKinds = null,
	schedulableKinds = null,
	i18n,
	locale,
}: CronPageProps) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, cronMessages(locale));
	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					{entries === null ? m.unavailableDescription : m.description(entries.length)}
				</p>
			</header>
			<Tabs defaultValue="schedules">
				<TabsList>
					<TabsTrigger value="schedules">{m.schedulesTab}</TabsTrigger>
					<TabsTrigger value="runs">{m.runsTitle}</TabsTrigger>
				</TabsList>
				<TabsContent value="schedules">
					<SchedulesSection
						entries={entries}
						kinds={scheduleKinds}
						schedulable={schedulableKinds}
						locale={locale}
						m={m}
					/>
				</TabsContent>
				<TabsContent value="runs">
					<RunsSection runs={runs} locale={locale} m={m} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
