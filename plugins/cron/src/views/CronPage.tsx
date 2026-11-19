import { useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { JobRecord } from "@ktb/jobs-port";
import type { CronJobInfo } from "@ktb/server-fns";
import { Button } from "@ktbhealth/ui/components/button";
import { JobStatus as JobStatusBadge } from "@ktbhealth/ui/components/job-status";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { runCronJobFn } from "../fns.ts";
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

export function CronPage({ jobs, runs, i18n, locale }: CronPageProps) {
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
					<TabsTrigger value="runs">{m.runsTitle}</TabsTrigger>
				</TabsList>
				<TabsContent value="jobs">
					<JobsSection jobs={jobs} locale={locale} m={m} />
				</TabsContent>
				<TabsContent value="runs">
					<RunsSection runs={runs} locale={locale} m={m} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
