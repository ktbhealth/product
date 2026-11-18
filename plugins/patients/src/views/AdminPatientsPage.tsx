import { Link, useRouter } from "@tanstack/react-router";
import { useMemo, useState, useSyncExternalStore } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import { patientDeleteApi } from "../apis.ts";
import type { AdminPatientRow, OwnerOption } from "../index.ts";
import { patientMessages, I18N_NAMESPACE } from "../i18n.ts";
import { isCipheredPatient } from "../zk.ts";
import { AdminPatientCreateDialog } from "./AdminPatientCreateDialog.tsx";
import { DeletePatientDialog } from "./DeletePatientDialog.tsx";

const SEARCH_CLS = "w-56 sm:w-64";

/**
 * /platform/patients console view — cross-owner patient CRUD for
 * platform admins. Dense/utilitarian by design (system console).
 * Edit reuses the owner-facing form (admin override in the service);
 * delete runs the same cascade dialog as the doctor surface.
 */
export function AdminPatientsPage({
	patients,
	owners,
	i18n,
	locale = "en",
}: {
	patients: AdminPatientRow[];
	/** User accounts for the create form's owner picker. */
	owners: OwnerOption[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host via the panel page ctx. */
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, patientMessages(locale));
	const router = useRouter();
	const [q, setQ] = useState("");
	// `toLocaleString` resolves in the runtime timezone — UTC on the SSR
	// worker vs the browser's zone — so the text is only emitted on the
	// client or the server/client markup diverges.
	const mounted = useSyncExternalStore(
		() => () => {},
		() => true,
		() => false,
	);
	const fmtDate = (d: Date) => (mounted ? d.toLocaleString(locale) : "");
	const [showSynthetic, setShowSynthetic] = useState(false);
	const [creating, setCreating] = useState(false);
	const [toDelete, setToDelete] = useState<{ id: number; name: string } | null>(null);
	const needle = q.trim().toLowerCase();
	const shown = useMemo(() => {
		// Synthetic rows (eval validator cohorts) stay hidden unless the
		// admin asks for them — real records are the default view.
		const pool = showSynthetic ? patients : patients.filter((p) => !p.synthetic);
		if (needle === "") return pool;
		return pool.filter((p) =>
			[p.name, p.ownerName, p.ownerEmail].filter(Boolean).join(" ").toLowerCase().includes(needle),
		);
	}, [patients, needle, showSynthetic]);
	return (
		<PageContainer>
			<PageHeader
				title={t.admin.title}
				description={patients.length === 0 ? t.admin.none : t.admin.count(patients.length)}
				actions={
					<Button size="sm" onClick={() => setCreating(true)}>
						<PlusIcon />
						{t.admin.newPatient}
					</Button>
				}
			/>
			{patients.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.admin.emptyTitle}</EmptyTitle>
						<EmptyDescription>{t.admin.emptyDescription}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<>
					<DataToolbar
						search={
							<div className="flex items-center gap-3">
								<Input
									type="search"
									value={q}
									onChange={(e) => setQ(e.target.value)}
									placeholder={t.admin.searchPlaceholder}
									aria-label={t.admin.searchLabel}
									className={SEARCH_CLS}
								/>
								<label className="flex items-center gap-1.5 text-xs text-muted-foreground">
									<Checkbox
										checked={showSynthetic}
										onCheckedChange={(v) => setShowSynthetic(v === true)}
									/>
									{t.admin.showSynthetic}
								</label>
							</div>
						}
						resultCount={
							needle === "" ? undefined : t.admin.filteredCount(shown.length, patients.length)
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-14">{t.admin.colId}</TableHead>
									<TableHead>{t.admin.colName}</TableHead>
									<TableHead>{t.admin.colOwner}</TableHead>
									<TableHead>{t.admin.colOwnerId}</TableHead>
									<TableHead className="text-right">{t.admin.colCreated}</TableHead>
									<TableHead className="w-24 text-right">{t.admin.colActions}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{shown.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="text-xs text-muted-foreground">
											{t.admin.noMatch}
										</TableCell>
									</TableRow>
								) : (
									shown.map((p) => {
										// ZK rows (T-144): the console holds no keys — every
										// surface (name, aria labels, delete dialog) uses the
										// opaque label, never the envelope.
										const rowName = isCipheredPatient(p) ? t.zk.lockedRecord : p.name;
										return (
											<TableRow key={p.id}>
												<TableCell className="text-xs text-muted-foreground">{p.id}</TableCell>
												<TableCell className="font-medium">
													{isCipheredPatient(p) ? (
														// ZK row (T-144): the console has no keys —
														// the envelope stays opaque.
														<span className="text-muted-foreground">{t.zk.lockedRecord}</span>
													) : (
														<Link
															to="/patients/$id"
															params={{ id: String(p.id) }}
															className="hover:underline"
														>
															{p.name}
														</Link>
													)}
													{p.synthetic === true && (
														<Badge variant="outline" className="ml-2">
															{t.admin.syntheticBadge}
														</Badge>
													)}
												</TableCell>
												<TableCell>{p.ownerName ?? p.ownerEmail ?? "—"}</TableCell>
												<TableCell className="text-xs text-muted-foreground">{p.ownerId}</TableCell>
												<TableCell className="text-right text-muted-foreground">
													{fmtDate(p.createdAt)}
												</TableCell>
												<TableCell className="text-right">
													<div className="flex justify-end gap-1">
														{/* Real link, not Button render=: it navigates, so it
														    keeps link semantics (and avoids the Base UI
														    nativeButton warning). */}
														<Link
															to="/patients/$id/edit"
															params={{ id: String(p.id) }}
															aria-label={t.actions.editFor(rowName)}
															className={buttonVariants({ variant: "ghost", size: "icon" })}
														>
															<PencilIcon />
														</Link>
														<Button
															variant="ghost"
															size="icon"
															aria-label={t.actions.deleteFor(rowName)}
															onClick={() => setToDelete({ id: p.id, name: rowName })}
														>
															<Trash2Icon />
														</Button>
													</div>
												</TableCell>
											</TableRow>
										);
									})
								)}
							</TableBody>
						</Table>
					</div>
				</>
			)}
			{creating ? (
				<AdminPatientCreateDialog
					owners={owners}
					t={t}
					locale={locale}
					i18n={i18n}
					onClose={() => setCreating(false)}
				/>
			) : null}
			<DeletePatientDialog
				patient={toDelete}
				api={patientDeleteApi}
				t={t}
				onClose={() => setToDelete(null)}
				onDeleted={() => {
					setToDelete(null);
					void router.invalidate();
				}}
			/>
		</PageContainer>
	);
}
