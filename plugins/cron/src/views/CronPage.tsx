import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { JobRecord } from "@ktb/jobs-port";
import type { CronJobInfo, ScheduledJobInfo, SchedulableKindInfo } from "@ktb/server-fns";
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
 * /platform/cron — the Concurrency console page. Two signal sections,
 * each honest about degradation: jobs (the scheduled-job registry
 * joined with its latest job_runs row) and runs (the `cron.*`
 * projection feed). "Run now" fires the same registry path the
 * worker's `scheduled` handler uses.
 */

interface CronPageProps {
	readonly jobs: readonly CronJobInfo[] | null;
	readonly runs: readonly JobRecord[] | null;
	readonly schedules?: readonly ScheduledJobInfo[] | null;
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

type RunState = {
	readonly pending: boolean;
	readonly message: string | null;
	readonly ok: boolean;
};

function JobsSection({
	jobs,
	locale,
	m,
}: {
	jobs: readonly CronJobInfo[] | null;
	locale: string;
	m: CronMessages;
}) {
	const [states, setStates] = useState<Record<string, RunState>>({});
	const runNow = async (id: string) => {
		setStates((s) => ({ ...s, [id]: { pending: true, message: null, ok: false } }));
		try {
			const result = await runCronJobFn({ data: { id } });
			setStates((s) => ({
				...s,
				[id]: { pending: false, message: runNowMessage(result, m), ok: result.ok },
			}));
		} catch {
			setStates((s) => ({ ...s, [id]: { pending: false, message: m.runFailed, ok: false } }));
		}
	};
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.jobsTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.jobsDescription}</p>
			{jobs === null ? (
				<Unavailable m={m} />
			) : jobs.length === 0 ? (
				<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
					{m.emptyJobsTitle} — {m.emptyJobsDescription}
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.jColJob}</TableHead>
							<TableHead>{m.jColSchedules}</TableHead>
							<TableHead>{m.jColDescription}</TableHead>
							<TableHead>{m.jColLastRun}</TableHead>
							<TableHead className="text-right">{m.jColAction}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{jobs.map((job) => {
							const state = states[job.id];
							return (
								<TableRow key={job.id}>
									<TableCell className="font-medium">{job.id}</TableCell>
									<TableCell>
										<div className="flex flex-col gap-0.5">
											{job.schedules.map((s) => (
												<code key={s} className="text-xs">
													{s}
												</code>
											))}
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground max-w-64 text-xs">
										{job.description ?? "—"}
									</TableCell>
									<TableCell className="text-xs whitespace-nowrap">
										{job.lastRun === null ? (
											<span className="text-muted-foreground">{m.neverRan}</span>
										) : (
											<span className="flex flex-col">
												<span
													className={
														job.lastRun.running
															? "text-muted-foreground"
															: job.lastRun.ok
																? "text-success"
																: "text-destructive"
													}
												>
													{job.lastRun.running
														? m.lastRunning
														: job.lastRun.ok
															? m.lastOk
															: m.lastFailed}
												</span>
												<span className="text-muted-foreground">
													{fmt(job.lastRun.startedAt, locale)}
												</span>
												{job.lastRun.error !== null && job.lastRun.error !== undefined && (
													<span
														className="text-destructive max-w-48 truncate"
														title={job.lastRun.error}
													>
														{job.lastRun.error}
													</span>
												)}
											</span>
										)}
									</TableCell>
									<TableCell className="text-right">
										<Button
											size="sm"
											variant="outline"
											disabled={state?.pending === true}
											onClick={() => void runNow(job.id)}
										>
											{state?.pending === true ? m.running : m.runNow}
										</Button>
										{state?.message !== null && state?.message !== undefined && (
											<p
												className={`mt-1 text-xs ${state.ok ? "text-success" : "text-destructive"}`}
											>
												{state.message}
											</p>
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

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

const statusLabel = (status: ScheduledJobInfo["status"], m: CronMessages) =>
	status === "active" ? m.statusActive : status === "paused" ? m.statusPaused : m.statusDone;

function SchedulesSection({
	schedules,
	kinds,
	schedulable = null,
	locale,
	m,
}: {
	schedules: readonly ScheduledJobInfo[] | null;
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

	const act = async (job: ScheduledJobInfo, action: "pause" | "resume" | "delete" | "run") => {
		setRowBusy(`${action}:${job.id}`);
		setMessage(null);
		try {
			if (action === "delete") {
				const result = await deleteScheduleFn({ data: { id: job.id } });
				setRowBusy(null);
				if (result.ok) {
					say(m.schedDeleted, true);
					refresh();
				} else {
					say(m.schedFailed, false);
				}
				return;
			}
			if (action === "run") {
				const result = await runScheduleFn({ data: { id: job.id } });
				setRowBusy(null);
				say(runNowMessage(result, m), result.ok);
				refresh();
				return;
			}
			const result = await updateScheduleFn({
				data: {
					id: job.id,
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
			{schedules === null ? (
				<Unavailable m={m} />
			) : (
				<>
					{schedules.length === 0 ? (
						<div className="border-border text-muted-foreground mb-4 rounded-md border px-4 py-6 text-sm">
							{m.emptySchedulesTitle} — {m.emptySchedulesDescription}
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{m.sColKind}</TableHead>
									<TableHead>{m.sColSchedule}</TableHead>
									<TableHead>{m.sColNextRun}</TableHead>
									<TableHead>{m.sColLastRun}</TableHead>
									<TableHead>{m.sColStatus}</TableHead>
									<TableHead className="text-right">{m.sColAction}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{schedules.map((job) => (
									<TableRow key={job.id}>
										<TableCell className="font-medium">{job.kind}</TableCell>
										<TableCell>
											{job.cronExpr !== null ? (
												<code className="text-xs">{job.cronExpr}</code>
											) : (
												<span className="text-xs">{fmt(job.runAt, locale)}</span>
											)}
										</TableCell>
										<TableCell className="text-xs whitespace-nowrap">
											{fmt(job.nextRunAt, locale)}
										</TableCell>
										<TableCell className="text-xs whitespace-nowrap">
											{job.lastRunAt === null ? (
												<span className="text-muted-foreground">{m.neverRan}</span>
											) : (
												fmt(job.lastRunAt, locale)
											)}
										</TableCell>
										<TableCell>
											<span
												className={
													job.status === "active" ? "text-success" : "text-muted-foreground"
												}
											>
												{statusLabel(job.status, m)}
											</span>
										</TableCell>
										<TableCell className="text-right">
											<div className="flex justify-end gap-1">
												{job.status === "active" && (
													<>
														<Button
															size="sm"
															variant="outline"
															disabled={rowBusy !== null}
															onClick={() => void act(job, "run")}
														>
															{m.runNow}
														</Button>
														<Button
															size="sm"
															variant="outline"
															disabled={rowBusy !== null}
															onClick={() => void act(job, "pause")}
														>
															{m.actPause}
														</Button>
													</>
												)}
												{job.status === "paused" && (
													<Button
														size="sm"
														variant="outline"
														disabled={rowBusy !== null}
														onClick={() => void act(job, "resume")}
													>
														{m.actResume}
													</Button>
												)}
												<Button
													size="sm"
													variant="outline"
													disabled={rowBusy !== null}
													onClick={() => void act(job, "delete")}
												>
													{m.actDelete}
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
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
								{message !== null && (
									<span className={`text-xs ${message.ok ? "text-success" : "text-destructive"}`}>
										{message.text}
									</span>
								)}
							</div>
						</div>
					</div>
				</>
			)}
		</section>
	);
}

export function CronPage({
	jobs,
	runs,
	schedules = null,
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
					{jobs === null ? m.unavailableDescription : m.description(jobs.length)}
				</p>
			</header>
			<Tabs defaultValue="jobs">
				<TabsList>
					<TabsTrigger value="jobs">{m.jobsTitle}</TabsTrigger>
					<TabsTrigger value="schedules">{m.schedulesTab}</TabsTrigger>
					<TabsTrigger value="runs">{m.runsTitle}</TabsTrigger>
				</TabsList>
				<TabsContent value="jobs">
					<JobsSection jobs={jobs} locale={locale} m={m} />
				</TabsContent>
				<TabsContent value="schedules">
					<SchedulesSection
						schedules={schedules}
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
