import { useEffect, useMemo, useRef, useState } from "react";

import type { PageContext } from "@ktb/kernel";
import { SchemaForm } from "@ktb/forms";
import { formsMessages } from "@ktb/forms";
import type { FormDefinition } from "@ktb/forms";
import { sliceMessages } from "@ktb/i18n";
import { Alert, AlertTitle } from "@ktbhealth/ui/components/alert";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import {
	collectWizardDefinitions,
	wizardIdFromPath,
	type WizardDefinition,
	type WizardStep,
} from "../definition.ts";
import {
	abandonWizardFn,
	advanceWizardFn,
	backWizardFn,
	defFromWire,
	runViewFromWire,
	startWizardFn,
	wizardDefsFn,
	type WizardDefWire,
	type WizardRunView,
	type WizardRunWire,
} from "../fns.ts";
import { I18N_NAMESPACE, wizardsMessages } from "../i18n.ts";

/**
 * `/wizards/<id>` runner — resolves the wizard id against defs from
 * BOTH sources: `wizard.def` contributions in `ctx.plugins` (the
 * enabled-filtered client registry) and published `wizard_defs` rows
 * fetched via `wizardDefsFn` (DB defs win on id collision — admins are
 * authoritative, same rule as the service's startRun). The run itself
 * lives server-side; this component drives it through the plugin's
 * session-gated server fns.
 */

type Phase = "loading" | "ready" | "error" | "notfound";

const formDefinitionFor = (step: Extract<WizardStep, { kind: "form" }>): FormDefinition => ({
	id: step.id,
	title: step.title,
	description: step.description,
	schema: step.schema,
	ui: step.ui,
	submitLabel: step.submitLabel,
});

export interface WizardRunnerProps {
	readonly data: unknown;
	readonly ctx: PageContext;
}

export function WizardRunner({ data, ctx }: WizardRunnerProps) {
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, wizardsMessages(ctx.locale));
	const id = typeof data === "string" ? wizardIdFromPath(data) : null;

	// Code-contributed defs (client registry) merged with published DB
	// defs (fetched once). DB wins on collision.
	const codeDefs = useMemo(() => collectWizardDefinitions(ctx.plugins), [ctx.plugins]);
	const [dbDefs, setDbDefs] = useState<readonly WizardDefWire[]>([]);
	const [dbLoaded, setDbLoaded] = useState(false);
	useEffect(() => {
		let cancelled = false;
		void wizardDefsFn()
			.then((rows) => {
				if (!cancelled) setDbDefs(rows);
			})
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setDbLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, []);
	const definitions = useMemo(() => {
		const byId = new Map<string, WizardDefinition>();
		for (const def of codeDefs) byId.set(def.id, def);
		for (const row of dbDefs) {
			const def = defFromWire(row);
			if (def !== null) byId.set(row.key, def);
		}
		return byId;
	}, [codeDefs, dbDefs]);

	const [phase, setPhase] = useState<Phase>("loading");
	const [run, setRun] = useState<WizardRunView | null>(null);
	const [busy, setBusy] = useState(false);
	const startedRef = useRef(false);

	const definition = id === null ? undefined : definitions.get(id);

	// Start a fresh run once the definition resolves AND the DB-def
	// fetch settled — a published DB def must shadow the code def
	// BEFORE the run starts, not after (v1 has no run resume —
	// abandoning is explicit).
	useEffect(() => {
		if (definition === undefined || !dbLoaded || startedRef.current) return;
		startedRef.current = true;
		setPhase("loading");
		void startWizardFn({ data: { key: definition.id, definition } })
			.then((wire) => {
				const view = runViewFromWire(wire);
				if (view === null) {
					setPhase("error");
					return;
				}
				setRun(view);
				setPhase("ready");
			})
			.catch(() => setPhase("error"));
	}, [definition, dbLoaded]);

	// A run parked at the done position (active + no step — e.g. a
	// previous completion attempt failed) finishes via advance.
	const finishingRef = useRef(false);
	useEffect(() => {
		if (run === null || run.status !== "active" || run.step !== null) return;
		/* v8 ignore next -- StrictMode double-effect guard: the first
		 * in-flight finish must not be duplicated by a re-run */
		if (finishingRef.current) return;
		finishingRef.current = true;
		void advanceWizardFn({ data: { runId: run.id } })
			.then((wire) => {
				const view = runViewFromWire(wire);
				if (view !== null) setRun(view);
			})
			.catch(() => undefined)
			.finally(() => {
				finishingRef.current = false;
			});
	}, [run]);

	const act = (promise: Promise<WizardRunWire | null>) => {
		setBusy(true);
		void promise
			.then((wire) => {
				const view = runViewFromWire(wire);
				if (view === null) {
					setPhase("error");
					return;
				}
				setRun(view);
			})
			.catch(() => setPhase("error"))
			.finally(() => setBusy(false));
	};

	if (id === null || (dbLoaded && definition === undefined)) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyTitle>{t.notFoundTitle}</EmptyTitle>
					<EmptyDescription>{t.notFoundDescription}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	if (phase === "error") {
		return (
			<Alert variant="destructive" className="mx-auto my-16 max-w-lg">
				<AlertTitle>{t.runError}</AlertTitle>
			</Alert>
		);
	}

	if (phase === "loading" || run === null) {
		return (
			<div className="flex items-center justify-center gap-2 py-16 text-muted-foreground">
				<Spinner />
				<span>{t.loading}</span>
			</div>
		);
	}

	if (run.status !== "active") {
		const completed = run.status === "completed";
		return (
			<Card className="mx-auto my-16 max-w-lg">
				<CardHeader>
					<CardTitle>{completed ? t.completedTitle : t.abandonedTitle}</CardTitle>
					<CardDescription>
						{completed ? t.completedDescription : t.abandonedDescription}
					</CardDescription>
				</CardHeader>
			</Card>
		);
	}

	const step = run.step;
	const stepIndex = run.definition.steps.findIndex((s) => s.id === step?.id);
	const total = run.definition.steps.length;

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
			<header className="flex flex-col gap-1">
				<h1 className="text-2xl font-semibold tracking-tight">{run.definition.title ?? run.key}</h1>
				{run.definition.description !== undefined && (
					<p className="text-sm text-muted-foreground">{run.definition.description}</p>
				)}
				{step !== null && (
					<p className="text-xs text-muted-foreground">{t.stepProgress(stepIndex + 1, total)}</p>
				)}
			</header>

			{step !== null && (
				<>
					{step.kind === "info" ? (
						<Card>
							<CardHeader>
								<CardTitle>{step.title ?? step.id}</CardTitle>
								{step.description !== undefined && (
									<CardDescription>{step.description}</CardDescription>
								)}
							</CardHeader>
							{step.body !== undefined && (
								<CardContent>
									<p className="text-sm whitespace-pre-wrap">{step.body}</p>
								</CardContent>
							)}
						</Card>
					) : (
						<SchemaForm
							definition={formDefinitionFor(step)}
							messages={formsMessages(ctx.locale)}
							initialValue={run.answers[step.id]}
							idPrefix={`wizard-${run.id}-${step.id}`}
							onSubmit={(value) =>
								act(
									advanceWizardFn({
										data: { runId: run.id, stepId: step.id, value },
									}),
								)
							}
						/>
					)}

					<div className="flex items-center justify-between gap-2">
						<div className="flex gap-2">
							{run.canGoBack && (
								<Button
									variant="outline"
									disabled={busy}
									onClick={() => act(backWizardFn({ data: { runId: run.id } }))}
								>
									{t.back}
								</Button>
							)}
							<Button
								variant="ghost"
								disabled={busy}
								onClick={async () => {
									await abandonWizardFn({ data: { runId: run.id } });
									setRun((current) =>
										current === null
											? /* v8 ignore next -- the button only renders while a
												run is active */ null
											: { ...current, status: "abandoned" },
									);
								}}
							>
								{t.abandon}
							</Button>
						</div>
						{step.kind === "info" && (
							<Button
								disabled={busy}
								onClick={() => act(advanceWizardFn({ data: { runId: run.id, stepId: step.id } }))}
							>
								{t.continueLabel}
							</Button>
						)}
					</div>
				</>
			)}
		</div>
	);
}
