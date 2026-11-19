import { useMemo, useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { JobRecord, JobStatus } from "@ktb/jobs-port";
import type { QueueInfo } from "@ktb/server-fns";
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

import { enqueueJobFn } from "../fns.ts";
import { I18N_NAMESPACE, queueMessages, type QueueMessages } from "../i18n.ts";

/**
 * /platform/queue — the Concurrency console page. Three signal
 * sections, each honest about degradation: queues (registry probe),
 * runs (job_runs projection) and enqueue (admin test job). The runs
 * table keeps a client-side kind/status filter so switching doesn't
 * round-trip.
 */

interface QueuePageProps {
	readonly queues: readonly QueueInfo[] | null;
	readonly runs: readonly JobRecord[] | null;
	readonly kinds: readonly string[] | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	readonly i18n?: PageI18nSlice;
	readonly locale: string;
}

type TransportKey =
	| "transportCloudflare"
	| "transportRedis"
	| "transportSqlite"
	| "transportUnknown";
type ConsumerKey = "consumerInApp" | "consumerJobsWorker" | "consumerExternal" | "consumerNone";
type StatusKey = "statusQueued" | "statusProcessing" | "statusDone" | "statusFailed";

const transportKey = (t: QueueInfo["transport"]): TransportKey => {
	switch (t) {
		case "cloudflare-queue":
			return "transportCloudflare";
		case "redis":
			return "transportRedis";
		case "sqlite":
			return "transportSqlite";
		default:
			return "transportUnknown";
	}
};

const consumerKey = (c: QueueInfo["consumer"]): ConsumerKey => {
	switch (c) {
		case "in-app":
			return "consumerInApp";
		case "jobs-worker":
			return "consumerJobsWorker";
		case "external":
			return "consumerExternal";
		default:
			return "consumerNone";
	}
};

const statusKey = (s: JobStatus): StatusKey => {
	switch (s) {
		case "queued":
			return "statusQueued";
		case "processing":
			return "statusProcessing";
		case "done":
			return "statusDone";
		default:
			return "statusFailed";
	}
};

const fmt = (ts: number | string | null | undefined, locale: string) =>
	ts === null || ts === undefined
		? "—"
		: new Date(ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" });

const DepthCell = ({ value }: { value: number | null }) => (
	<span className="tabular-nums">{value === null ? "—" : value}</span>
);

const Unavailable = ({ m }: { m: QueueMessages }) => (
	<div className="border-border rounded-md border px-4 py-6 text-sm">
		<span className="font-medium">{m.unavailableTitle}</span>
		<span className="text-muted-foreground"> — {m.unavailableDescription}</span>
	</div>
);

function QueuesSection({ queues, m }: { queues: readonly QueueInfo[] | null; m: QueueMessages }) {
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.queuesTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.queuesDescription}</p>
			{queues === null ? (
				<Unavailable m={m} />
			) : queues.length === 0 ? (
				<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
					{m.emptyQueuesTitle} — {m.emptyQueuesDescription}
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.qColQueue}</TableHead>
							<TableHead>{m.qColTransport}</TableHead>
							<TableHead>{m.qColConsumer}</TableHead>
							<TableHead className="text-right">{m.qColPending}</TableHead>
							<TableHead className="text-right">{m.qColProcessing}</TableHead>
							<TableHead className="text-right">{m.qColDone}</TableHead>
							<TableHead className="text-right">{m.qColFailed}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{queues.map((q) => (
							<TableRow key={q.id}>
								<TableCell className="font-medium">{q.name}</TableCell>
								<TableCell>{m[transportKey(q.transport)]}</TableCell>
								<TableCell>{m[consumerKey(q.consumer)]}</TableCell>
								<TableCell className="text-right">
									<DepthCell value={q.depth?.pending ?? null} />
								</TableCell>
								<TableCell className="text-right">
									<DepthCell value={q.depth?.processing ?? null} />
								</TableCell>
								<TableCell className="text-right">
									<DepthCell value={q.depth?.done ?? null} />
								</TableCell>
								<TableCell className="text-right">
									<DepthCell value={q.depth?.failed ?? null} />
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

const STATUS_VALUES: readonly JobStatus[] = ["queued", "processing", "done", "failed"];

function RunsSection({
	runs,
	kinds,
	locale,
	m,
}: {
	runs: readonly JobRecord[] | null;
	kinds: readonly string[] | null;
	locale: string;
	m: QueueMessages;
}) {
	const [kindFilter, setKindFilter] = useState("");
	const [statusFilter, setStatusFilter] = useState<"" | JobStatus>("");
	const filtered = useMemo(
		() =>
			(runs ?? []).filter(
				(r) =>
					(kindFilter === "" || r.kind === kindFilter) &&
					(statusFilter === "" || r.status === statusFilter),
			),
		[runs, kindFilter, statusFilter],
	);
	const kindOptions = kinds ?? [...new Set((runs ?? []).map((r) => r.kind))].sort();
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.runsTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.runsDescription}</p>
			{runs === null ? (
				<Unavailable m={m} />
			) : (
				<>
					<div className="mb-3 flex flex-wrap items-center gap-2">
						<select
							aria-label={m.filterKind}
							className="border-input bg-background rounded-md border px-2 py-1 text-sm"
							value={kindFilter}
							onChange={(e) => setKindFilter(e.target.value)}
						>
							<option value="">{m.kindAll}</option>
							{kindOptions.map((k) => (
								<option key={k} value={k}>
									{k}
								</option>
							))}
						</select>
						<select
							aria-label={m.filterStatus}
							className="border-input bg-background rounded-md border px-2 py-1 text-sm"
							value={statusFilter}
							onChange={(e) => setStatusFilter(e.target.value as "" | JobStatus)}
						>
							<option value="">{m.statusAll}</option>
							{STATUS_VALUES.map((s) => (
								<option key={s} value={s}>
									{m[statusKey(s)]}
								</option>
							))}
						</select>
					</div>
					{filtered.length === 0 ? (
						<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
							{runs.length === 0 ? `${m.emptyRunsTitle} — ${m.emptyRunsDescription}` : m.noMatch}
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{m.rColId}</TableHead>
									<TableHead>{m.rColKind}</TableHead>
									<TableHead>{m.rColStatus}</TableHead>
									<TableHead>{m.rColError}</TableHead>
									<TableHead>{m.rColCreated}</TableHead>
									<TableHead>{m.rColPayloadRef}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filtered.map((r) => (
									<TableRow key={r.id}>
										<TableCell className="font-mono text-xs">{r.id.slice(0, 8)}</TableCell>
										<TableCell className="font-medium">{r.kind}</TableCell>
										<TableCell>
											<JobStatusBadge status={r.status} />
										</TableCell>
										<TableCell className="max-w-48 truncate text-xs" title={r.error ?? ""}>
											{r.error ?? "—"}
										</TableCell>
										<TableCell className="text-xs whitespace-nowrap">
											{fmt(r.createdAt, locale)}
										</TableCell>
										<TableCell className="text-xs">{r.payloadRef ?? "—"}</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</>
			)}
		</section>
	);
}

function EnqueueSection({ kinds, m }: { kinds: readonly string[] | null; m: QueueMessages }) {
	const [kind, setKind] = useState("");
	const [payload, setPayload] = useState("");
	const [pending, setPending] = useState(false);
	const [result, setResult] = useState<"idle" | "ok" | "err" | "invalid">("idle");
	const submit = async () => {
		let parsed: unknown = {};
		if (payload.trim() !== "") {
			try {
				parsed = JSON.parse(payload);
			} catch {
				setResult("invalid");
				return;
			}
		}
		setPending(true);
		try {
			const res = await enqueueJobFn({ data: { kind, payload: parsed } });
			setResult(res.ok ? "ok" : "err");
		} catch {
			setResult("err");
		} finally {
			setPending(false);
		}
	};
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.enqueueTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.enqueueDescription}</p>
			{kinds === null || kinds.length === 0 ? (
				<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
					{kinds === null ? m.unavailableDescription : m.noKinds}
				</div>
			) : (
				<div className="border-border rounded-md border p-4">
					<div className="flex flex-wrap items-end gap-2">
						<label className="flex flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{m.enqueueKind}</span>
							<select
								className="border-input bg-background rounded-md border px-2 py-1 text-sm"
								value={kind}
								onChange={(e) => setKind(e.target.value)}
							>
								<option value="">{m.selectKind}</option>
								{kinds.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</select>
						</label>
						<label className="flex min-w-64 flex-1 flex-col gap-1 text-sm">
							<span className="text-muted-foreground">{m.payloadLabel}</span>
							<input
								className="border-input bg-background rounded-md border px-2 py-1 font-mono text-sm"
								placeholder={m.payloadPlaceholder}
								value={payload}
								onChange={(e) => {
									setPayload(e.target.value);
									setResult("idle");
								}}
							/>
						</label>
						<Button size="sm" disabled={kind === "" || pending} onClick={submit}>
							{m.enqueueSubmit}
						</Button>
					</div>
					<p className="text-muted-foreground mt-2 text-xs">{m.payloadHint}</p>
					{result === "ok" && <p className="mt-2 text-sm text-success">{m.enqueueSuccess}</p>}
					{result === "err" && <p className="mt-2 text-sm text-destructive">{m.enqueueError}</p>}
					{result === "invalid" && (
						<p className="mt-2 text-sm text-destructive">{m.payloadInvalid}</p>
					)}
				</div>
			)}
		</section>
	);
}

export function QueuePage({ queues, runs, kinds, i18n, locale }: QueuePageProps) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, queueMessages(locale));
	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					{runs === null ? m.unavailableDescription : m.description(runs.length)}
				</p>
			</header>
			<Tabs defaultValue="queues">
				<TabsList>
					<TabsTrigger value="queues">{m.queuesTitle}</TabsTrigger>
					<TabsTrigger value="runs">{m.runsTitle}</TabsTrigger>
					<TabsTrigger value="enqueue">{m.enqueueTitle}</TabsTrigger>
				</TabsList>
				<TabsContent value="queues">
					<QueuesSection queues={queues} m={m} />
				</TabsContent>
				<TabsContent value="runs">
					<RunsSection runs={runs} kinds={kinds} locale={locale} m={m} />
				</TabsContent>
				<TabsContent value="enqueue">
					<EnqueueSection kinds={kinds} m={m} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
