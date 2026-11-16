import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
	DownloadIcon,
	EllipsisVerticalIcon,
	LockIcon,
	PencilIcon,
	PlusIcon,
	Trash2Icon,
	UsersIcon,
} from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuTrigger,
} from "@ktbhealth/ui/components/dropdown-menu";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { SearchInput } from "@ktbhealth/ui/components/search-input";
import type { Patient } from "../index.ts";
import { patientMessages, I18N_NAMESPACE } from "../i18n.ts";
import { formatCpf } from "../record.ts";
import { decryptPatients, isCipheredPatient, type PatientZk } from "../zk.ts";
import { demographics, displayName, initials } from "./-format.ts";
import { exportLinks } from "./-export.ts";
import { DeletePatientDialog, type PatientDeleteApi } from "./DeletePatientDialog.tsx";

export type PatientListItem = Pick<
	Patient,
	"id" | "name" | "socialName" | "gender" | "birthDate" | "cpf" | "cns" | "active"
>;

export function PatientsPage({
	patients,
	i18n,
	locale,
	deleteApi,
	onDeleted,
	portalBase,
	zk,
}: {
	patients: PatientListItem[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host. */
	locale: string;
	deleteApi: PatientDeleteApi;
	/** Called once a patient (and their consultations) are gone — the host refreshes the list. */
	onDeleted: (id: number) => void;
	/** Portal instance base path — internal links stay under it (P-081). */
	portalBase?: string;
	/** ZK context (T-144): present only on ZK tenants — rows arrive as
	 * `v1.` envelopes and are decrypted in the browser; rows without a
	 * grant render a locked card. */
	zk?: PatientZk;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, patientMessages(locale));
	const portalPath = (path: string) => (portalBase ? `${portalBase}${path}` : path);
	const [q, setQ] = useState("");
	const [toDelete, setToDelete] = useState<{ id: number; name: string } | null>(null);

	// Client-side decrypt under ZK (T-144): ciphertext names sort
	// alphabetically server-side, so the decrypted list re-sorts by name.
	const [decrypted, setDecrypted] = useState<ReadonlyMap<number, PatientListItem>>(new Map());
	useEffect(() => {
		if (!zk) return;
		let live = true;
		decryptPatients(zk.keyring, zk.api, patients)
			.then((rows) => {
				if (live) setDecrypted(new Map(rows.map((r) => [r.id, r])));
			})
			.catch(() => {});
		return () => {
			live = false;
		};
	}, [zk, patients]);

	const display = useMemo(() => {
		const rows = patients.map((p) => decrypted.get(p.id) ?? p);
		if (zk) rows.sort((a, b) => a.name.localeCompare(b.name));
		return rows;
	}, [patients, decrypted, zk]);

	const shown = useMemo(() => {
		const needle = q.trim().toLowerCase();
		if (!needle) return display;
		const digits = needle.replace(/\D/g, "");
		return display.filter(
			(p) =>
				[p.name, p.socialName].some((t) => t?.toLowerCase().includes(needle)) ||
				(digits !== "" && [p.cpf, p.cns].some((id) => id?.includes(digits))),
		);
	}, [display, q]);

	return (
		<div>
			<div className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-3xl font-bold tracking-tight">{t.common.patients}</h1>
					<p className="mt-1 text-sm text-muted-foreground">
						{patients.length === 0 ? t.list.none : t.list.count(patients.length)}
					</p>
				</div>
				<Button nativeButton={false} render={<Link to={portalPath("/patients/new")} />}>
					<PlusIcon data-icon="inline-start" />
					{t.common.newPatient}
				</Button>
			</div>

			{patients.length > 0 ? (
				<SearchInput
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder={t.list.searchPlaceholder}
					aria-label={t.list.searchLabel}
					className="mt-5 w-full max-w-sm"
				/>
			) : null}

			<div className="mt-4 space-y-3">
				{shown.map((p) =>
					isCipheredPatient(p) ? (
						// Locked row (T-144): no grant for this device — the
						// envelope stays opaque, the card is not navigable.
						<article
							key={p.id}
							className="flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm"
						>
							<div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
								<LockIcon className="size-4" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="font-semibold">{t.zk.lockedRecord}</p>
								<p className="mt-0.5 text-sm text-muted-foreground">{t.zk.lockedHint}</p>
							</div>
						</article>
					) : (
						<article
							key={p.id}
							className="group relative flex items-center gap-4 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-foreground/20 hover:shadow"
						>
							<div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-primary/15 to-primary/5 text-sm font-semibold text-primary">
								{initials(displayName(p))}
							</div>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-baseline gap-x-2">
									<Link
										to={portalPath(`/patients/${p.id}`)}
										className="font-semibold after:absolute after:inset-0 after:content-['']"
									>
										{displayName(p)}
									</Link>
									{p.socialName ? (
										<span className="text-xs text-muted-foreground">({p.name})</span>
									) : null}
								</div>
								<p className="mt-0.5 text-sm text-muted-foreground">
									{[
										demographics(p, locale, undefined, i18n),
										p.cpf ? `CPF ${formatCpf(p.cpf)}` : null,
									]
										.filter(Boolean)
										.join(" · ") || t.common.noDemographics}
								</p>
							</div>
							<div className="flex shrink-0 flex-wrap justify-end gap-1.5">
								{!p.active ? <Badge variant="outline">{t.common.inactive}</Badge> : null}
								{!p.birthDate ? <Badge variant="outline">{t.list.incomplete}</Badge> : null}
							</div>
							{/* Above the card's stretched link so the actions stay clickable. */}
							<div className="relative z-10 flex shrink-0 items-center gap-1">
								<Button
									variant="ghost"
									size="icon"
									aria-label={t.actions.editFor(displayName(p))}
									render={<Link to={portalPath(`/patients/${p.id}/edit`)} />}
								>
									<PencilIcon />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t.actions.deleteFor(displayName(p))}
									onClick={() => setToDelete({ id: p.id, name: displayName(p) })}
								>
									<Trash2Icon />
								</Button>
								<DropdownMenu>
									<DropdownMenuTrigger
										render={
											<Button
												variant="ghost"
												size="icon"
												aria-label={t.actions.menu(displayName(p))}
											/>
										}
									>
										<EllipsisVerticalIcon />
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										<DropdownMenuGroup>
											<DropdownMenuLabel>{t.detail.exportRecord}</DropdownMenuLabel>
											{exportLinks(t, p.id).map(({ format, label, href }) => (
												<DropdownMenuItem key={format} render={<a href={href} download />}>
													<DownloadIcon />
													{label}
												</DropdownMenuItem>
											))}
										</DropdownMenuGroup>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						</article>
					),
				)}

				<DeletePatientDialog
					patient={toDelete}
					api={deleteApi}
					t={t}
					onClose={() => setToDelete(null)}
					onDeleted={(id) => {
						setToDelete(null);
						onDeleted(id);
					}}
				/>

				{patients.length > 0 && shown.length === 0 ? (
					<Empty className="border">
						<EmptyDescription>{t.list.noMatch}</EmptyDescription>
					</Empty>
				) : null}

				{!patients.length ? (
					<Empty className="border bg-card px-6 py-16">
						<EmptyHeader>
							<EmptyMedia variant="icon">
								<UsersIcon />
							</EmptyMedia>
							<EmptyTitle>{t.list.emptyTitle}</EmptyTitle>
							<EmptyDescription>{t.list.emptyDescription}</EmptyDescription>
						</EmptyHeader>
						<EmptyContent>
							<Button nativeButton={false} render={<Link to={portalPath("/patients/new")} />}>
								{t.common.registerPatient}
							</Button>
						</EmptyContent>
					</Empty>
				) : null}
			</div>
		</div>
	);
}
