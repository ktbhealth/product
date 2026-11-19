import { useMemo, type ReactNode } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import {
	ConfirmAction,
	SearchInput,
	TablePage,
	useServerMutation,
	useTableQuery,
	type Column,
} from "@ktb/views/table";

import { Button } from "@ktbhealth/ui/components/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { JobStatus, type JobStatusValue } from "@ktbhealth/ui/components/job-status";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import type { AudioStorageStats, QueueDepth } from "@ktb/server-fns";
import { LocalDateTime } from "@ktb/views/views";

import { retryAudioJobFn } from "../fns.ts";
import { isAudioRetryable, jobStatusOf, type AudioJobRow } from "../jobs.ts";
import { opsMessages, type OpsMessages, I18N_NAMESPACE } from "../i18n.ts";

const fmtBytes = (bytes: number, locale: string): string => {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toLocaleString(locale, { maximumFractionDigits: 1 })} ${units[unit]}`;
};

const statusLabel = (t: OpsMessages, status: string): string => {
	switch (status) {
		case "stored":
			return t.statusStored;
		case "queued":
			return t.statusQueued;
		case "processing":
			return t.statusProcessing;
		case "done":
			return t.statusDone;
		case "failed":
			return t.statusFailed;
		/* v8 ignore next -- unreachable: jobRows are pre-filtered to mapped audio statuses */
		default:
			return status;
	}
};

/** Shared section chrome — dense console card with a titled header. */
function OpsSection({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: ReactNode;
}) {
	return (
		<section className="overflow-hidden rounded-lg border border-border">
			<header className="border-b border-border px-3 py-2">
				<h2 className="text-sm font-medium">{title}</h2>
				<p className="text-xs text-muted-foreground">{description}</p>
			</header>
			<div className="p-3">{children}</div>
		</section>
	);
}

/** Unavailable-signal placeholder — honest "cannot read" state. */
function Unavailable({ t }: { t: OpsMessages }) {
	return (
		<Empty className="border-0 py-6">
			<EmptyHeader>
				<EmptyTitle className="text-sm">{t.unavailableTitle}</EmptyTitle>
				<EmptyDescription className="text-xs">{t.unavailableDescription}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

/**
 * /platform/ops console view (T-035) — aggregates the ops signals that
 * actually exist: the consultation audio-pipeline job table (with admin
 * retry for failed/stored rows), the transcription queue depth (dev
 * queue only — prod reports unavailable), audio bucket storage stats,
 * and a webhook section that reports its missing delivery log instead
 * of faking data. Dense/utilitarian by design (system console).
 *
 * The jobs section uses the shared table kit (`@ktb/views/table`):
 * `useTableQuery` predicate search, `TablePage.Table` columns and
 * `ConfirmAction` + `useServerMutation` for the retry flow. The queue,
 * storage and webhook sections are signal cards, not tables, and stay
 * plugin-local.
 */
export function OpsPage({
	jobs,
	queue,
	storage,
	i18n,

	locale = "en",
}: {
	/** null = the signal could not be read (Forbidden/runtime missing). */
	jobs: readonly AudioJobRow[] | null;
	queue: QueueDepth | null;
	storage: AudioStorageStats | null;
	/** Active UI locale, injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, opsMessages(locale));

	const jobRows = useMemo(
		() => (jobs ?? []).filter((j) => jobStatusOf(j.audioStatus) !== null),
		[jobs],
	);
	const query = useTableQuery<AudioJobRow>({
		rows: jobRows,
		search: {
			predicate: (job, needle) =>
				[job.patientName ?? "", String(job.id), job.audioError ?? ""]
					.join(" ")
					.toLowerCase()
					.includes(needle),
		},
	});
	const retry = useServerMutation<{ consultationId: number }>(retryAudioJobFn);

	const jobColumns: Column<AudioJobRow>[] = [
		{
			key: "id",
			header: t.colConsultation,
			width: "5rem",
			render: (job) => <span className="font-mono text-xs">#{job.id}</span>,
		},
		{
			key: "patientName",
			header: t.colPatient,
			render: (job) => <span className="text-xs">{job.patientName ?? t.noPatient}</span>,
		},
		{
			key: "status",
			header: t.colStatus,
			render: (job) => {
				const badge = jobStatusOf(job.audioStatus) as JobStatusValue;
				return <JobStatus status={badge} label={statusLabel(t, job.audioStatus)} />;
			},
		},
		{
			key: "error",
			header: t.colError,
			render: (job) => (
				<span className="block max-w-56 truncate text-xs text-muted-foreground">
					{job.audioError ?? ""}
				</span>
			),
		},
		{
			key: "createdAt",
			header: t.colCreated,
			align: "right",
			render: (job) => (
				<span className="text-xs text-muted-foreground">
					<LocalDateTime value={job.createdAt} locale={locale} fallback="" />
				</span>
			),
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (job) =>
				isAudioRetryable(job.audioStatus) ? (
					<ConfirmAction
						trigger={(open) => (
							<Button type="button" variant="ghost" size="sm" disabled={retry.busy} onClick={open}>
								{t.retry}
							</Button>
						)}
						title={t.retryTitle}
						description={t.retryDescription(`#${job.id}`)}
						confirmLabel={t.retryConfirm}
						cancelLabel={t.cancel}
						onConfirm={() => retry.mutate({ consultationId: job.id })}
					/>
				) : null,
		},
	];

	return (
		<PageContainer>
			<PageHeader
				title={t.title}
				description={jobs === null ? undefined : t.description(jobRows.length)}
			/>
			<div className="flex flex-col gap-4">
				<OpsSection title={t.jobsTitle} description={t.jobsDescription}>
					{jobs === null ? (
						<Unavailable t={t} />
					) : jobRows.length === 0 ? (
						<Empty className="border">
							<EmptyHeader>
								<EmptyTitle>{t.emptyJobsTitle}</EmptyTitle>
								<EmptyDescription>{t.emptyJobsDescription}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<>
							<TablePage.Toolbar
								search={
									<SearchInput
										value={query.q}
										onChange={query.setQ}
										placeholder={t.searchPlaceholder}
										aria-label={t.searchLabel}
									/>
								}
								resultCount={query.isFiltered ? `${query.shown}/${query.total}` : undefined}
							/>
							{retry.error ? <p className="mb-2 text-xs text-destructive">{t.retryError}</p> : null}
							<TablePage.Table
								columns={jobColumns}
								rows={query.rows}
								rowKey={(job) => String(job.id)}
								total={jobRows.length}
								isFiltered={query.isFiltered}
								noMatch={t.noMatch}
								locale={locale}
							/>
						</>
					)}
				</OpsSection>

				<OpsSection title={t.queueTitle} description={t.queueDescription}>
					{queue === null ? (
						<Unavailable t={t} />
					) : (
						<dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
							{(
								[
									["pending", t.queuePending],
									["processing", t.queueProcessing],
									["done", t.queueDone],
									["failed", t.queueFailed],
								] as const
							).map(([key, label]) => (
								<div key={key} className="rounded-md border border-border px-3 py-2">
									<dt className="text-xs text-muted-foreground">{label}</dt>
									<dd className="text-lg font-semibold tabular-nums">{queue[key]}</dd>
								</div>
							))}
						</dl>
					)}
				</OpsSection>

				<OpsSection title={t.storageTitle} description={t.storageDescription}>
					{storage === null ? (
						<Unavailable t={t} />
					) : (
						<div className="flex flex-col gap-1">
							<p className="text-sm">
								<span className="font-semibold tabular-nums">
									{t.storageObjects(storage.objects)}
								</span>{" "}
								<span className="text-muted-foreground">· {fmtBytes(storage.bytes, locale)}</span>
							</p>
							{storage.truncated ? (
								<p className="text-xs text-muted-foreground">{t.storageTruncated}</p>
							) : null}
						</div>
					)}
				</OpsSection>

				<OpsSection title={t.webhooksTitle} description={t.webhooksDescription}>
					<p className="text-xs text-muted-foreground">{t.webhooksUnavailable}</p>
				</OpsSection>
			</div>
		</PageContainer>
	);
}
