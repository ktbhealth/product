import { useCallback, useEffect, useRef, useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Progress } from "@ktbhealth/ui/components/progress";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { wordDiff } from "@ktb/eval-consultation";
import { EvalSteps } from "@ktb/eval-persona/steps";

import {
	deleteRunFn,
	listCohortItemsFn,
	listCohortsFn,
	listRunsFn,
	progressFn,
	reviewItemFn,
	startRunFn,
} from "../fns.ts";
import { evalMessages, I18N_NAMESPACE, type EvalMessages } from "../i18n.ts";
import type {
	AxisAggregate,
	CohortItemCard,
	CohortSummary,
	RunListItem,
	RunProgress,
} from "../index.ts";

const stateVariant = (state: string) =>
	state === "approved" ? "default" : state === "rejected" ? "destructive" : "secondary";

/** WS-G view widening: `runnerBound`/`queueBound` report whether the
 * run can actually execute (a queued run with no bound runner never
 * leaves the queue) and `experiment` is the eval-core record when the
 * server surfaces it. All optional at runtime — older servers omit
 * them and the UI renders nothing — so this compiles both before and
 * after the fields land on RunProgress. */
interface RunProgressView extends RunProgress {
	readonly runnerBound?: boolean;
	readonly queueBound?: boolean;
	readonly experiment?: {
		readonly profile?: string;
		readonly manifestHash?: string;
	} | null;
}

/** /platform/eval view — step 3 of the pipeline: cohort list →
 * consultation review cards → run progress. The cohort IS the step-2
 * generation instance; the run consumes its approved items only,
 * never regenerating. Run polling is effect-scoped — no leaked
 * timers. */
export function EvalValidatorPage({
	cohorts: initial,
	i18n,
	locale,
}: {
	cohorts: readonly CohortSummary[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale: string;
}) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, evalMessages(locale));
	const [cohorts, setCohorts] = useState<readonly CohortSummary[]>(initial);
	const [items, setItems] = useState<readonly CohortItemCard[]>([]);
	const [runs, setRuns] = useState<readonly RunListItem[]>([]);
	const [selectedCohort, setSelectedCohort] = useState<number | null>(null);
	const [run, setRun] = useState<RunProgressView | null>(null);
	const [feedback, setFeedback] = useState<Record<number, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [activeRunId, setActiveRunId] = useState<number | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async (cohortId: number) => {
		const list = await listCohortsFn({ data: {} });
		if (list.ok) setCohorts(list.data);
		const p = await listCohortItemsFn({ data: { cohortId } });
		if (p.ok) setItems(p.data);
		const rr = await listRunsFn({ data: { cohortId } });
		if (rr.ok) setRuns(rr.data);
	}, []);

	// card.instanceId (not selectedCohort) drives the refresh — the
	// card knows its own cohort, no null path to defend.
	const review = async (card: CohortItemCard, decision: "approved" | "rejected") => {
		setBusy(true);
		setError(null);
		try {
			const r = await reviewItemFn({
				data: {
					itemId: card.id,
					decision,
					feedback: feedback[card.id] || undefined,
				},
			});
			if (!r.ok) {
				setError(m.actionFailed);
				return;
			}
			await refresh(card.instanceId);
		} finally {
			setBusy(false);
		}
	};

	const [confirmDelete, setConfirmDelete] = useState(false);
	const removeRun = async () => {
		/* v8 ignore next 3 -- guard: the delete button only renders when a run is loaded */
		if (run === null) return;
		setBusy(true);
		const r = await deleteRunFn({ data: { runId: run.id } });
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setRun(null);
		setActiveRunId(null);
		setConfirmDelete(false);
	};

	const startRun = async (instanceId: number) => {
		setBusy(true);
		try {
			const r = await startRunFn({ data: { instanceId } });
			if (r.ok) setActiveRunId(r.data.runId);
		} finally {
			setBusy(false);
		}
	};

	// Reopen a past run — the poll effect self-terminates on done/failed,
	// so pointing activeRunId at history is safe for both live and old runs.
	const viewRun = (runId: number) => setActiveRunId(runId);

	// Poll the active run until it leaves `running`/`queued` — effect
	// cleanup kills the timer on unmount or when a new run starts.
	useEffect(() => {
		if (activeRunId === null) return;
		const timer: { current: ReturnType<typeof setTimeout> | undefined } = {
			current: undefined,
		};
		const tick = async () => {
			const p = await progressFn({ data: { runId: activeRunId } });
			if (!mounted.current) return;
			// Transient failures must not kill the loop — a run takes
			// minutes, one hiccup shouldn't freeze the progress bar.
			// `data === null` means the run row is gone: stop for real.
			if (!p.ok) {
				timer.current = setTimeout(() => {
					void tick();
				}, 2000);
				return;
			}
			if (p.data === null) return;
			setRun(p.data);
			if (p.data.status === "running" || p.data.status === "queued") {
				timer.current = setTimeout(() => {
					void tick();
				}, 2000);
			}
		};
		void tick();
		return () => {
			if (timer.current !== undefined) clearTimeout(timer.current);
		};
	}, [activeRunId]);

	return (
		<PageContainer>
			<EvalSteps active={3} labels={[m.stepPersonas, m.stepGenerate, m.stepRunEval]} />
			<PageHeader title={m.title} description={m.description} />
			{error !== null && <p className="text-sm text-destructive">{error}</p>}

			{cohorts.length === 0 && (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{m.title}</EmptyTitle>
						<EmptyDescription>{m.emptyCohorts}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{cohorts.map((c) => (
				<Card key={c.id}>
					<CardHeader className="flex-row items-center justify-between">
						<CardTitle>
							{c.name} #{c.id} — {c.count} {m.items}
						</CardTitle>
						<div className="flex items-center gap-2">
							{c.status !== "ready" && (
								<Badge variant="outline">
									{c.status === "generating" ? m.generating : c.status}
								</Badge>
							)}
							<Badge variant="secondary">
								{c.pending} {m.pending}
							</Badge>
							<Badge>
								{c.approved} {m.approved}
							</Badge>
							<Badge variant="destructive">
								{c.rejected} {m.rejected}
							</Badge>
							<Badge variant="outline">{c.state}</Badge>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setSelectedCohort(c.id);
									void refresh(c.id);
								}}
							>
								{m.view}
							</Button>
							<Button size="sm" disabled={c.approved === 0 || busy} onClick={() => startRun(c.id)}>
								{m.runEval}
							</Button>
						</div>
					</CardHeader>
				</Card>
			))}

			{selectedCohort !== null && runs.length > 0 && (
				<Card>
					<CardHeader>
						<CardTitle>
							{m.run}s — {m.stepRunEval}
						</CardTitle>
					</CardHeader>
					<CardContent className="space-y-1">
						{runs.map((r) => {
							const sum = r.summary as { meanWer?: number } | null;
							return (
								<div key={r.id} className="flex items-center gap-2 text-xs">
									<Badge
										variant={
											r.status === "done"
												? "default"
												: r.status === "failed"
													? "destructive"
													: "secondary"
										}
									>
										{r.status}
									</Badge>
									<span>
										{m.run} #{r.id} — {r.done}/{r.total} {m.samplesOf}
										{sum?.meanWer !== undefined && ` · mean WER ${sum.meanWer.toFixed(3)}`}
									</span>
									<Button size="sm" variant="outline" onClick={() => viewRun(r.id)}>
										{m.view}
									</Button>
								</div>
							);
						})}
					</CardContent>
				</Card>
			)}

			{run !== null && (
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center justify-between gap-2">
							<span>
								{m.run} #{run.id} — {run.status}
							</span>
							{confirmDelete ? (
								<Button
									variant="destructive"
									size="sm"
									disabled={busy}
									onClick={() => void removeRun()}
								>
									{m.confirmDelete}
								</Button>
							) : (
								<Button
									variant="outline"
									size="sm"
									disabled={busy}
									onClick={() => setConfirmDelete(true)}
								>
									{m.deleteRun}
								</Button>
							)}
						</CardTitle>
						{(run.status === "queued" || run.status === "running") && (
							<RunnerNotice run={run} m={m} />
						)}
					</CardHeader>
					<CardContent>
						<RunMeta run={run} />
						<Progress value={run.pct} />
						<p className="mt-2 text-sm text-muted-foreground">
							{run.done}/{run.total} {m.samplesOf} — {run.pct}%
						</p>
						<SummaryLine summary={run.summary} />
						{run.done > 0 && <Aggregates aggregates={run.aggregates} />}
						{run.samples.map((s) => (
							<div key={s.id} className="mt-1 text-xs">
								item {s.itemId}: {s.status}
								{s.error !== null ? ` — ${s.error}` : ""}
								{s.status === "ok" && (
									<audio
										controls
										preload="none"
										className="mt-1 h-8 w-full max-w-md"
										src={`/api/eval/${s.id}/audio`}
									/>
								)}
								{s.result !== null && s.script !== null && (
									<SampleResult result={s.result} script={s.script} />
								)}
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{selectedCohort !== null && items.length === 0 && (
				<Empty>
					<EmptyHeader>
						<EmptyDescription>{m.emptyItems}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{items.map((p) => (
				<Card key={p.id}>
					<CardHeader className="flex-row items-center justify-between">
						<CardTitle className="text-base">
							{p.persona?.name ?? `#${p.id}`} — {p.persona?.gender} · {p.persona?.socialClass} ·{" "}
							{p.persona?.education} · {p.persona?.region} · {p.persona?.specialty}
						</CardTitle>
						<div className="flex items-center gap-2">
							{p.status !== "done" && <Badge variant="outline">{p.status}</Badge>}
							{p.scriptMode !== null && <Badge variant="outline">{p.scriptMode}</Badge>}
							<Badge variant={stateVariant(p.state)}>{p.state}</Badge>
						</div>
					</CardHeader>
					<CardContent>
						{p.error !== null && <p className="text-xs text-destructive">{p.error}</p>}
						<p className="text-xs text-muted-foreground">
							{m.doctor}: {p.persona?.doctor?.gender}/{p.persona?.doctor?.register} · {m.voices}:{" "}
							{p.voices.doctor} / {p.voices.patient}
						</p>
						{(p.patientId !== null || p.doctorId !== null) && (
							<p className="mt-1 text-xs text-muted-foreground">
								<Badge variant="outline" className="mr-1">
									{m.synthetic}
								</Badge>
								patient #{p.patientId ?? "—"} · doctor #{p.doctorId ?? "—"}
							</p>
						)}
						{p.turns.length > 0 && (
							<div className="mt-2 max-h-96 overflow-auto rounded border p-2 text-sm">
								{p.turns.map((t, i) => (
									<div key={i}>
										<strong>{t.speaker}:</strong> {t.text}
									</div>
								))}
							</div>
						)}
						{p.feedback !== null && (
							<p className="mt-2 text-xs italic">
								{m.feedback}: {p.feedback}
							</p>
						)}
						{p.status === "done" && (
							<>
								<Textarea
									placeholder={m.feedbackPlaceholder}
									value={feedback[p.id] ?? ""}
									onChange={(e) => setFeedback((f) => ({ ...f, [p.id]: e.target.value }))}
								/>
								<div className="mt-2 flex gap-2">
									<Button size="sm" onClick={() => review(p, "approved")}>
										{m.approve}
									</Button>
									<Button size="sm" variant="destructive" onClick={() => review(p, "rejected")}>
										{m.reject}
									</Button>
								</div>
							</>
						)}
					</CardContent>
				</Card>
			))}
		</PageContainer>
	);
}

/** Execution-availability honesty for live runs: a queued run with
 * no bound runner never leaves the queue, and a bound runner without
 * a jobs queue executes inline — both worth a glance before waiting
 * on the progress bar. Older payloads omit the flags and render
 * nothing. */
function RunnerNotice({ run, m }: { run: RunProgressView; m: EvalMessages }) {
	if (run.runnerBound === false) {
		return (
			<div className="mt-1">
				<Badge variant="destructive">{m.noRunnerBound}</Badge>
			</div>
		);
	}
	if (run.runnerBound === true && run.queueBound === false) {
		return (
			<div className="mt-1">
				<Badge variant="outline">{m.runnerInline}</Badge>
			</div>
		);
	}
	return null;
}

/** Dataset/experiment identity for the run card — the cohort dataset
 * comes from run.params ({instanceId, itemIds}); the eval-core
 * experiment record (profile + manifest hash) renders when the server
 * surfaces it. All muted metadata, English like the rest of the run
 * card's metric labels. */
function RunMeta({ run }: { run: RunProgressView }) {
	const params = run.params as { readonly instanceId?: unknown } | null;
	const instanceId = typeof params?.instanceId === "number" ? params.instanceId : null;
	const experiment = run.experiment ?? null;
	const parts: string[] = [];
	if (instanceId !== null) parts.push(`dataset eval-instance-${instanceId}`);
	if (typeof experiment?.profile === "string" && experiment.profile.length > 0) {
		parts.push(`profile ${experiment.profile}`);
	}
	if (typeof experiment?.manifestHash === "string" && experiment.manifestHash.length > 0) {
		parts.push(`manifest ${experiment.manifestHash.slice(0, 12)}`);
	}
	if (parts.length === 0) return null;
	return <p className="mt-1 text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}

interface CleanupResult {
	readonly edits?: number;
	readonly corrected?: string;
	readonly werAfter?: number;
	readonly cerAfter?: number;
	readonly error?: string;
}

interface AnamnesisResult {
	readonly engine?: string;
	readonly sections?: number;
	readonly filled?: number;
	readonly completeness?: number;
	readonly error?: string;
}

interface SampleResultJson {
	readonly wer?: number;
	readonly cer?: number;
	readonly asrText?: string;
	readonly stages?: readonly string[];
	readonly cleanup?: CleanupResult;
	readonly anamnesis?: AnamnesisResult;
}

/** Run-level mean chips — parsed from the run summary JSON the
 * finish step persists ({meanWer, meanWerAfter, meanCompleteness}). */
function SummaryLine({ summary }: { summary: unknown }) {
	if (summary === null || typeof summary !== "object") return null;
	const s = summary as {
		readonly meanWer?: number;
		readonly meanWerAfter?: number;
		readonly meanCompleteness?: number;
	};
	return (
		<div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
			{typeof s.meanWer === "number" && <span>mean WER {s.meanWer.toFixed(3)}</span>}
			{typeof s.meanWerAfter === "number" && <span>after cleanup {s.meanWerAfter.toFixed(3)}</span>}
			{typeof s.meanCompleteness === "number" && (
				<span>anamnesis {(s.meanCompleteness * 100).toFixed(0)}%</span>
			)}
		</div>
	);
}

/** Parsed metrics block under a finished sample — per-stage results:
 * WER/CER + gold↔ASR diff, then the cleanup stage (edits, WER delta,
 * corrected-vs-gold diff) and the anamnesis stage (engine +
 * section completeness) when the run exercised them. */
function SampleResult({ result, script }: { result: string; script: string }) {
	let parsed: SampleResultJson;
	try {
		parsed = JSON.parse(result) as SampleResultJson;
	} catch {
		return null;
	}
	const c = parsed.cleanup;
	const a = parsed.anamnesis;
	return (
		<div className="mt-1 rounded border p-2 text-xs">
			{typeof parsed.wer === "number" && <span>WER {parsed.wer.toFixed(3)} </span>}
			{typeof parsed.cer === "number" && <span>CER {parsed.cer.toFixed(3)}</span>}
			{parsed.asrText !== undefined && <DiffBlock refText={script} hypText={parsed.asrText} />}
			{c !== undefined && (
				<div className="mt-2 border-t pt-1">
					<Badge variant="outline">cleanup</Badge>{" "}
					{c.error !== undefined ? (
						<span className="text-destructive">{c.error}</span>
					) : (
						<>
							<span>
								{c.edits ?? 0} edits — WER→{c.werAfter?.toFixed(3) ?? "—"}
							</span>
							{c.corrected !== undefined && <DiffBlock refText={script} hypText={c.corrected} />}
						</>
					)}
				</div>
			)}
			{a !== undefined && (
				<div className="mt-2 border-t pt-1">
					<Badge variant="outline">anamnesis</Badge>{" "}
					{a.error !== undefined ? (
						<span className="text-destructive">{a.error}</span>
					) : (
						<span>
							{a.engine ?? "—"} — {a.filled ?? 0}/{a.sections ?? 8} sections (
							{Math.round((a.completeness ?? 0) * 100)}%)
						</span>
					)}
				</div>
			)}
		</div>
	);
}

/** Per-axis mean WER — "where does the engine fail" at a glance:
 * one row per axis, chips sorted worst-first so the failing slice
 * pops out. Slices with no ok samples render "—". */
function Aggregates({ aggregates }: { aggregates: readonly AxisAggregate[] }) {
	return (
		<div className="mt-3 space-y-2 rounded border p-2 text-xs">
			{aggregates.map((a) => (
				<div key={a.axis}>
					<span className="font-medium text-muted-foreground">{a.axis}</span>
					{[...a.slices]
						.sort((x, y) => (y.meanWer ?? -1) - (x.meanWer ?? -1))
						.map((s) => (
							<div key={s.key} className="mt-1 flex items-center gap-2">
								<span className="w-32 shrink-0 truncate">{s.key}</span>
								<div className="h-2 flex-1 rounded bg-muted">
									<div
										className="h-2 rounded bg-destructive/70"
										style={{ width: `${Math.min(1, s.meanWer ?? 0) * 100}%` }}
									/>
								</div>
								<span className="w-20 shrink-0 text-right tabular-nums">
									{s.meanWer === null ? "—" : s.meanWer.toFixed(2)} ({s.ok}/{s.samples})
								</span>
							</div>
						))}
				</div>
			))}
		</div>
	);
}

/** One diff op → one styled span: ok plain, sub pairs ref↓hyp,
 * del struck-through, ins green. Runs per render on ~1.2k-word
 * scripts — alignWords is O(n·m) memory; fine at this scale. */
function DiffBlock({ refText, hypText }: { refText: string; hypText: string }) {
	const diff = wordDiff(refText, hypText);
	return (
		<div className="mt-1">
			<p className="text-muted-foreground">
				{diff.summary.ok} ok · {diff.summary.sub} sub · {diff.summary.del} del · {diff.summary.ins}{" "}
				ins — WER {diff.summary.wer.toFixed(3)}
			</p>
			<p className="mt-1 max-h-48 overflow-auto leading-6">
				{diff.ops.map((o, i) =>
					o.op === "ok" ? (
						<span key={i}> {o.hyp}</span>
					) : o.op === "sub" ? (
						<span key={i} className="text-destructive" title={o.ref}>
							{" "}
							{o.hyp}
						</span>
					) : o.op === "del" ? (
						<span key={i} className="text-muted-foreground line-through">
							{" "}
							{o.ref}
						</span>
					) : (
						<span key={i} className="text-success underline">
							{" "}
							+{o.hyp}
						</span>
					),
				)}
			</p>
		</div>
	);
}
