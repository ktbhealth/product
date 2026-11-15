import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Progress } from "@ktbhealth/ui/components/progress";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import { wordDiff } from "@ktb/eval-consultation";

import {
	generateBatchFn,
	listBatchesFn,
	listPersonasFn,
	progressFn,
	reviewPersonaFn,
	startRunFn,
} from "../fns.ts";
import { evalMessages } from "../i18n.ts";
import type { AxisAggregate, BatchSummary, PersonaCard, RunProgress } from "../index.ts";

const stateVariant = (state: string) =>
	state === "approved" ? "default" : state === "rejected" ? "destructive" : "secondary";

/** /platform/eval view (P-081): batch list → persona review cards →
 * run progress. Run polling is effect-scoped — no leaked timers. */
export function EvalValidatorPage({
	batches: initial,
	locale,
}: {
	batches: readonly BatchSummary[];
	locale: string;
}) {
	const m = evalMessages(locale);
	const [batches, setBatches] = useState<readonly BatchSummary[]>(initial);
	const [personas, setPersonas] = useState<readonly PersonaCard[]>([]);
	const [selectedBatch, setSelectedBatch] = useState<number | null>(null);
	const [run, setRun] = useState<RunProgress | null>(null);
	const [feedback, setFeedback] = useState<Record<number, string>>({});
	const [busy, setBusy] = useState(false);
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
		try {
			const r = await generateBatchFn({ data: { count: 6 } });
			if (r.ok) {
				setSelectedBatch(r.data.batchId);
				await refresh(r.data.batchId);
			}
		} finally {
			setBusy(false);
		}
	};

	// p.batchId (not selectedBatch) drives the refresh — the card knows
	// its own batch, no null path to defend.
	const review = async (card: PersonaCard, decision: "approved" | "rejected") => {
		await reviewPersonaFn({
			data: { personaId: card.id, decision, feedback: feedback[card.id] },
		});
		await refresh(card.batchId);
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
			<div className="flex gap-2">
				<Button onClick={generate} disabled={busy}>
					{m.generate}
				</Button>
			</div>

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
						<CardTitle>
							{m.run} #{run.id} — {run.status}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<Progress value={run.pct} />
						<p className="mt-2 text-sm text-muted-foreground">
							{run.done}/{run.total} {m.samplesOf} — {run.pct}%
						</p>
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
						<Badge variant={stateVariant(p.state)}>{p.state}</Badge>
					</CardHeader>
					<CardContent>
						<p className="text-xs text-muted-foreground">
							{m.doctor}: {p.persona.doctor?.gender}/{p.persona.doctor?.register} · {m.voices}:{" "}
							{p.voices.doctor} / {p.voices.patient}
						</p>
						<div className="mt-2 max-h-48 overflow-auto rounded border p-2 text-sm">
							{p.turns.slice(0, 12).map((t, i) => (
								<div key={i}>
									<strong>{t.speaker}:</strong> {t.text}
								</div>
							))}
							{p.turns.length > 12 ? (
								<div>
									…{p.turns.length - 12} {m.moreTurns}
								</div>
							) : null}
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

/** Parsed metrics block under a finished sample — WER/CER plus the
 * word-level diff (gold script vs ASR text) so the reviewer sees where
 * the engine erred, not just the score. Keeps raw JSON out of the UI. */
function SampleResult({ result, script }: { result: string; script: string }) {
	let parsed: { wer?: number; cer?: number; asrText?: string };
	try {
		parsed = JSON.parse(result) as typeof parsed;
	} catch {
		return null;
	}
	return (
		<div className="mt-1 rounded border p-2 text-xs">
			{typeof parsed.wer === "number" && <span>WER {parsed.wer.toFixed(3)} </span>}
			{typeof parsed.cer === "number" && <span>CER {parsed.cer.toFixed(3)}</span>}
			{parsed.asrText !== undefined && <DiffBlock refText={script} hypText={parsed.asrText} />}
		</div>
	);
}

/** Per-axis mean WER — "where does the engine fail" at a glance:
 * one row per axis, chips sorted worst-first so the failing slice
 * pops out. Slices with no ok samples render "—". */
function Aggregates({ aggregates }: { aggregates: readonly AxisAggregate[] }) {
	return (
		<div className="mt-3 space-y-1 rounded border p-2 text-xs">
			{aggregates.map((a) => (
				<div key={a.axis} className="flex flex-wrap items-baseline gap-1">
					<span className="w-24 shrink-0 font-medium text-muted-foreground">{a.axis}</span>
					{[...a.slices]
						.sort((x, y) => (y.meanWer ?? -1) - (x.meanWer ?? -1))
						.map((s) => (
							<Badge key={s.key} variant="outline" className="font-normal">
								{s.key}: {s.meanWer === null ? "—" : s.meanWer.toFixed(2)} ({s.ok}/{s.samples})
							</Badge>
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
