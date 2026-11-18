import { Link } from "@tanstack/react-router";
import { CheckCircle2Icon, CircleIcon } from "lucide-react";

import { cn } from "@ktbhealth/ui/lib/utils";

/** The three eval pipeline surfaces in order — paths are the plugin
 * routes, fixed by the manifests (steps 1–2 in eval-persona, step 3
 * in eval-validator). */
const STEP_TO = ["/platform/eval/personas", "/platform/eval/instances", "/platform/eval"] as const;

export type EvalStep = 1 | 2 | 3;

/** Persistent pipeline strip rendered at the top of every eval
 * surface — makes the linear flow (personas → generate consultations
 * → run eval) visible from each step and doubles as navigation.
 * Labels come from the page's own i18n catalog so each plugin keeps
 * its copy local. */
export function EvalSteps({
	active,
	labels,
}: {
	readonly active: EvalStep;
	readonly labels: readonly [string, string, string];
}) {
	return (
		<nav aria-label="Eval pipeline" className="flex flex-wrap items-center gap-1 text-sm">
			{STEP_TO.map((to, i) => {
				const step = (i + 1) as EvalStep;
				const done = step < active;
				const current = step === active;
				return (
					<span key={to} className="flex items-center gap-1">
						{i > 0 && <span className="mx-1 text-muted-foreground">→</span>}
						<Link
							to={to}
							aria-current={current ? "step" : undefined}
							className={cn(
								"flex items-center gap-1.5 rounded-md px-2 py-1",
								current
									? "bg-accent font-medium text-accent-foreground"
									: "text-muted-foreground hover:text-foreground",
							)}
						>
							{done ? (
								<CheckCircle2Icon className="size-4 text-success" />
							) : (
								<CircleIcon className={cn("size-4", current && "text-accent-foreground")} />
							)}
							{labels[i]}
						</Link>
					</span>
				);
			})}
		</nav>
	);
}
