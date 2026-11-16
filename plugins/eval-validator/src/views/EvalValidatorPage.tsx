import { useCallback, useEffect, useRef, useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Progress } from "@ktbhealth/ui/components/progress";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { wordDiff } from "@ktb/eval-consultation";

import {
	deleteRunFn,
	generateBatchFn,
	listBatchesFn,
	listPersonasFn,
	progressFn,
	reviewPersonaFn,
	startRunFn,
} from "../fns.ts";
import { evalMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { AxisAggregate, BatchSummary, PersonaCard, RunProgress } from "../index.ts";

const stateVariant = (state: string) =>
	state === "approved" ? "default" : state === "rejected" ? "destructive" : "secondary";

/** /platform/eval view (P-081): batch list → persona review cards →
 * run progress. Run polling is effect-scoped — no leaked timers. */
export function EvalValidatorPage({
	batches: initial,
	i18n,
	locale,
}: {
	batches: readonly BatchSummary[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale: string;
}) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, evalMessages(locale));
	const [batches, setBatches] = useState<readonly BatchSummary[]>(initial);
	const [personas, setPersonas] = useState<readonly PersonaCard[]>([]);
	const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
	const [run, setRun] = useState<RunProgress | null>(null);
	const [feedback, setFeedback] = useState<Record<number, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [minutes, setMinutes] = useState(15);
	const [activeRunId, setActiveRunId] = useState<number | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async (batchId: number) => {
		const list = await listBatchesFn({ data: {} });
		if (list.ok) setBatches(list.data);
		const p = await listPersonasFn({ data: { batchId } });
		if (p.ok) setPersonas(p.data);
	}, []);

	const generate = async () => {
		setBusy(true);
		setError(null);
		try {
			const r = await generateBatchFn({ data: { count: 6, minutes } });
			if (r.ok) {
				setSelectedBatch(r.data.batchId);
				await refresh(r.data.batchId);
			} else {
				setError(m.actionFailed);
			}
		} finally {
			setBusy(false);
		}
	};

	// p.batchId (not selectedBatch) drives the refresh — the card knows
	// its own batch, no null path to defend.
	const review = async (card: PersonaCard, decision: "approved" | "rejected") => {
		setBusy(true);
		setError(null);
		try {
			const r = await reviewPersonaFn({
				data: {
					personaId: card.id,
					decision,
					feedback: feedback[card.id] || undefined,
				},
			});
			if (!r.ok) {
				setError(m.actionFailed);
				return;
			}
			await refresh(card.batchId);
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

	const startRun = async (batchId: number) => {
		setBusy(true);
		try {
			const r = await startRunFn({ data: { batchId } });
			if (r.ok) setActiveRunId(r.data.runId);
		} finally {
			setBusy(false);
		}
	};

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
			<PageHeader title={m.title} description={m.description} />
			<div className="flex items-end gap-2">
				<div className="grid gap-1">
					<label htmlFor="eval-minutes" className="text-xs text-muted-foreground">
						{m.minutesLabel}
					</label>
					<Input
						id="eval-minutes"
						type="number"
						min={1}
						max={60}
						className="w-24"
						value={minutes}
						onChange={(e) => setMinutes(Math.max(1, Number(e.target.value) || 1))}
					/>
				</div>
				<Button onClick={generate} disabled={busy}>
					{m.generate}
				</Button>
			</div>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}

			{batches.length === 0 && (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{m.title}</EmptyTitle>
						<EmptyDescription>{m.emptyBatches}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{batches.map((b) => (
				<Card key={b.id}>
					<CardHeader className="flex-row items-center justify-between">
						<CardTitle>
							Batch #{b.id} — {b.count} {m.personas}
						</CardTitle>
						<div className="flex items-center gap-2">
							<Badge variant="secondary">
								{b.pending} {m.pending}
							</Badge>
							<Badge>
								{b.approved} {m.approved}
							</Badge>
							<Badge variant="destructive">
								{b.rejected} {m.rejected}
							</Badge>
							<Badge variant="outline">{b.state}</Badge>
							<Button
								size="sm"
								variant="outline"
								onClick={() => {
									setSelectedBatch(b.id);
									void refresh(b.id);
								}}
							>
								{m.view}
							</Button>
							<Button size="sm" disabled={b.approved === 0 || busy} onClick={() => startRun(b.id)}>
								{m.runEval}
							</Button>
						</div>
					</CardHeader>
				</Card>
			))}

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
					</CardHeader>
					<CardContent>
						<Progress value={run.pct} />
						<p className="mt-2 text-sm text-muted-foreground">
							{run.done}/{run.total} {m.samplesOf} — {run.pct}%
						</p>
						<SummaryLine summary={run.summary} />
						{run.done > 0 && <Aggregates aggregates={run.aggregates} />}
						{run.samples.map((s) => (
							<div key={s.id} className="mt-1 text-xs">
								persona {s.personaId}: {s.status}
								{s.error !== null ? ` — ${s.error}` : ""}
								{s.status === "ok" && (
									<audio
										controls
										preload="none"
										className="mt-1 h-8 w-full max-w-md"
										src={`/api/eval/${s.id}/audio`}
									/>
								)}
								{s.result !== null && <SampleResult result={s.result} script={s.script} />}
							</div>
						))}
					</CardContent>
				</Card>
			)}

			{selectedBatch !== null && personas.length === 0 && (
				<Empty>
					<EmptyHeader>
						<EmptyDescription>{m.emptyPersonas}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			)}

			{personas.map((p) => (
				<Card key={p.id}>
					<CardHeader className="flex-row items-center justify-between">
						<CardTitle className="text-base">
							{p.persona.name} — {p.persona.gender} · {p.persona.socialClass} ·{" "}
							{p.persona.education} · {p.persona.region} · {p.persona.specialty}
						</CardTitle>
						<div className="flex items-center gap-2">
							{p.scriptMode !== null && <Badge variant="outline">{p.scriptMode}</Badge>}
							<Badge variant={stateVariant(p.state)}>{p.state}</Badge>
						</div>
					</CardHeader>
					<CardContent>
						<p className="text-xs text-muted-foreground">
							{m.doctor}: {p.persona.doctor?.gender}/{p.persona.doctor?.register} · {m.voices}:{" "}
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
						<div className="mt-2 max-h-96 overflow-auto rounded border p-2 text-sm">
							{p.turns.map((t, i) => (
								<div key={i}>
									<strong>{t.speaker}:</strong> {t.text}
								</div>
							))}
						</div>
						{p.feedback !== null && (
							<p className="mt-2 text-xs italic">
								{m.feedback}: {p.feedback}
							</p>
						)}
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
					</CardContent>
				</Card>
			))}
		</PageContainer>
	);
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
						<span key={i} className="text-emerald-600 underline">
							{" "}
							+{o.hyp}
						</span>
					),
				)}
			</p>
		</div>
	);
}
