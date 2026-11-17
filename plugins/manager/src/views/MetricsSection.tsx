import { useEffect, useState } from "react";

import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { getMetricsFn, type ManagerMetrics } from "../fns.ts";
import { managerMessages } from "../i18n.ts";

type LoadState =
	| { readonly status: "loading" }
	| { readonly status: "error" }
	| { readonly status: "ready"; readonly metrics: ManagerMetrics };

/** `null` avg (no histogram samples) renders as an em dash. */
const formatAvg = (value: number | null): string =>
	value === null ? "—" : String(Math.round(value));

/**
 * Runtime-metrics panel for /platform/plugins: per-serverFn request
 * counts/errors/avg duration and per-session-context lookup stats,
 * fetched once on mount via `getMetricsFn` (PlatformAdmin-gated
 * server-side). Counters are cumulative since process start — rates
 * need windows and are deliberately not shown.
 */
export function MetricsSection({ t }: { readonly t: ReturnType<typeof managerMessages> }) {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	useEffect(() => {
		let live = true;
		getMetricsFn()
			.then((metrics) => {
				if (!live) return;
				// `null` = non-admin (shouldn't happen behind the page gate)
				// — degrade to the empty state rather than an error.
				setState({
					status: "ready",
					metrics: metrics ?? { serverFns: [], sessionContexts: [] },
				});
			})
			.catch(() => {
				if (live) setState({ status: "error" });
			});
		return () => {
			live = false;
		};
	}, []);

	return (
		<section className="space-y-3">
			<div>
				<h2 className="text-sm font-medium">{t.metricsTitle}</h2>
				<p className="text-xs text-muted-foreground">{t.metricsSinceStart}</p>
			</div>
			{state.status === "loading" ? (
				<Spinner aria-label={t.metricsTitle} />
			) : state.status === "error" ? (
				<p className="text-sm text-destructive">{t.metricsError}</p>
			) : state.metrics.serverFns.length === 0 && state.metrics.sessionContexts.length === 0 ? (
				<p className="text-sm text-muted-foreground">{t.metricsEmpty}</p>
			) : (
				<>
					{state.metrics.serverFns.length > 0 ? (
						<div className="space-y-1.5">
							<h3 className="text-xs font-medium text-muted-foreground">{t.metricsServerFns}</h3>
							<div className="overflow-hidden rounded-lg border border-border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t.colFn}</TableHead>
											<TableHead className="text-right">{t.colRequests}</TableHead>
											<TableHead className="text-right">{t.colErrors}</TableHead>
											<TableHead className="text-right">{t.colAvgDuration}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{state.metrics.serverFns.map((row) => (
											<TableRow key={row.fn}>
												<TableCell className="max-w-64 truncate font-mono text-xs" title={row.fn}>
													{row.fn}
												</TableCell>
												<TableCell className="text-right">{row.requests}</TableCell>
												<TableCell className="text-right">{row.errors}</TableCell>
												<TableCell className="text-right">{formatAvg(row.avgDurationMs)}</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						</div>
					) : null}
					{state.metrics.sessionContexts.length > 0 ? (
						<div className="space-y-1.5">
							<h3 className="text-xs font-medium text-muted-foreground">
								{t.metricsSessionContexts}
							</h3>
							<div className="overflow-hidden rounded-lg border border-border">
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t.colContext}</TableHead>
											<TableHead className="text-right">{t.colLookups}</TableHead>
											<TableHead className="text-right">{t.colLoads}</TableHead>
											<TableHead className="text-right">{t.colAvgLoad}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{state.metrics.sessionContexts.map((row) => (
											<TableRow key={row.context}>
												<TableCell>{row.context}</TableCell>
												<TableCell className="text-right">{row.lookups}</TableCell>
												<TableCell className="text-right">{row.loads}</TableCell>
												<TableCell className="text-right">
													{formatAvg(row.avgLoadDurationMs)}
												</TableCell>
											</TableRow>
										))}
									</TableBody>
								</Table>
							</div>
						</div>
					) : null}
				</>
			)}
		</section>
	);
}
