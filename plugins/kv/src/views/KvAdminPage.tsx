import { useState } from "react";
import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ktbhealth/ui/components/alert-dialog";
import { Field, FieldDescription, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { NativeSelect, NativeSelectOption } from "@ktbhealth/ui/components/native-select";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { SearchInput } from "@ktbhealth/ui/components/search-input";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import {
	kvDeleteFn,
	kvListFn,
	kvNamespacesFn,
	kvSetFn,
	type KvEntryWire,
	type KvListWire,
	type KvNamespaceWire,
	type KvSetResult,
} from "../fns.ts";
import { I18N_NAMESPACE, kvMessages } from "../i18n.ts";

/** Loader-seeded console data — the panel page's first page of entries
 * plus the namespace overview. Subsequent pages/filters go through the
 * plugin's admin-gated server fns. */
export interface KvAdminPageData {
	readonly items: readonly KvEntryWire[];
	readonly total: number;
	readonly namespaces: readonly KvNamespaceWire[];
}

export interface KvAdminPageProps {
	readonly data: KvAdminPageData;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

const PAGE_SIZE = 50;
const PREVIEW_LENGTH = 80;

/** Milliseconds until `expiresAt` — kept out of the component body so the
 * render stays pure (same pattern as the agents page's `relative`). */
const remainingMs = (expiresAt: number): number => expiresAt - Date.now();

type TtlMode = "keep" | "none" | "custom";

interface FormState {
	readonly mode: "create" | "edit";
	readonly namespace: string;
	readonly key: string;
	readonly tenantId: string;
	readonly ownerId: string;
	readonly valueJson: string;
	readonly ttlMode: TtlMode;
	readonly ttlSeconds: string;
	/** CAS guard — the row's version when editing. */
	readonly expectedVersion?: number;
}

type FormError = "invalid" | "ttl" | "conflict" | "save" | null;

const preview = (value: unknown): string => {
	let text: string;
	try {
		text = JSON.stringify(value) ?? String(value);
	} catch {
		text = String(value);
	}
	return text.length > PREVIEW_LENGTH ? `${text.slice(0, PREVIEW_LENGTH)}…` : text;
};

const formFromRow = (row: KvEntryWire): FormState => ({
	mode: "edit",
	namespace: row.namespace,
	key: row.key,
	tenantId: row.tenantId === null ? "" : String(row.tenantId),
	ownerId: row.ownerId ?? "",
	valueJson: (() => {
		try {
			return JSON.stringify(row.value, null, 2);
		} catch {
			// Stored values are JSON.parse output — reaching here means the
			// wire carried something non-JSON (e.g. a bigint in tests).
			const v: unknown = row.value;
			return typeof v === "bigint" ? v.toString() : "[unserializable]";
		}
	})(),
	ttlMode: row.expiresAt === null ? "none" : "keep",
	ttlSeconds: "3600",
	expectedVersion: row.version,
});

const emptyForm = (namespace: string): FormState => ({
	mode: "create",
	namespace,
	key: "",
	tenantId: "",
	ownerId: "",
	valueJson: "null",
	ttlMode: "none",
	ttlSeconds: "3600",
});

/**
 * /platform/kv console view (P-090): browse, create, edit and delete
 * entries across every namespace and scope slice. Mutations go through
 * the plugin's admin-gated server fns; `expectedVersion` rides along
 * on edits so concurrent writes surface as conflicts instead of silent
 * overwrites. The loader seeds the first page; filters/pagination
 * refetch via `kvListFn`.
 */
export function KvAdminPage({ data, i18n, locale }: KvAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, kvMessages(locale));
	const initial = data;
	const [items, setItems] = useState<readonly KvEntryWire[]>(initial.items);
	const [total, setTotal] = useState(initial.total);
	const [namespaces, setNamespaces] = useState<readonly KvNamespaceWire[]>(initial.namespaces);
	const [namespace, setNamespace] = useState("");
	const [prefix, setPrefix] = useState("");
	const [page, setPage] = useState(1);
	const [loading, setLoading] = useState(false);
	const [loadFailed, setLoadFailed] = useState(false);
	const [form, setForm] = useState<FormState | null>(null);
	const [formError, setFormError] = useState<FormError>(null);
	const [deleteTarget, setDeleteTarget] = useState<KvEntryWire | null>(null);
	const [busy, setBusy] = useState(false);
	const [actionFailed, setActionFailed] = useState(false);

	/* v8 ignore next -- the form inputs only exist while the dialog is open */
	const patchForm = (p: Partial<FormState>) =>
		setForm((f) =>
			f === null
				? /* v8 ignore next -- unreachable: inputs only render while the dialog is open */ f
				: { ...f, ...p },
		);

	const load = async (targetPage: number, ns: string, keyPrefix: string) => {
		setLoading(true);
		setLoadFailed(false);
		try {
			const [list, nsCounts] = await Promise.all([
				kvListFn({
					data: {
						namespace: ns === "" ? undefined : ns,
						prefix: keyPrefix === "" ? undefined : keyPrefix,
						limit: PAGE_SIZE,
						offset: (targetPage - 1) * PAGE_SIZE,
					},
				}),
				kvNamespacesFn(),
			]);
			if (list === null) {
				setLoadFailed(true);
				return;
			}
			const wire: KvListWire = list;
			setItems(wire.items);
			setTotal(wire.total);
			setPage(targetPage);
			if (nsCounts !== null) setNamespaces(nsCounts);
		} catch {
			setLoadFailed(true);
		} finally {
			setLoading(false);
		}
	};

	const closeFormDialog = () => {
		setForm(null);
		setFormError(null);
	};

	const save = async () => {
		/* v8 ignore next -- the save action only exists while the form dialog is open */
		if (form === null) return;
		try {
			JSON.parse(form.valueJson);
		} catch {
			setFormError("invalid");
			return;
		}
		if (form.ttlMode === "custom") {
			const seconds = Number(form.ttlSeconds);
			if (!Number.isFinite(seconds) || seconds <= 0) {
				setFormError("ttl");
				return;
			}
		}
		setBusy(true);
		setFormError(null);
		try {
			const ttlMs =
				form.ttlMode === "keep"
					? undefined
					: form.ttlMode === "none"
						? null
						: Math.round(Number(form.ttlSeconds) * 1000);
			const result: KvSetResult = await kvSetFn({
				data: {
					namespace: form.namespace,
					key: form.key,
					tenantId: form.tenantId.trim() === "" ? null : form.tenantId.trim(),
					ownerId: form.ownerId.trim() === "" ? null : form.ownerId.trim(),
					valueJson: form.valueJson,
					ttlMs,
					expectedVersion: form.expectedVersion,
				},
			});
			if (result.ok) {
				setForm(null);
				await load(page, namespace, prefix);
			} else if (result.reason === "conflict") {
				setFormError("conflict");
			} else {
				setFormError("save");
			}
		} catch {
			setFormError("save");
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		/* v8 ignore next -- the delete action only exists while the confirm dialog is open */
		if (deleteTarget === null) return;
		setBusy(true);
		setActionFailed(false);
		try {
			const ok = await kvDeleteFn({
				data: {
					namespace: deleteTarget.namespace,
					key: deleteTarget.key,
					tenantId: deleteTarget.tenantId,
					ownerId: deleteTarget.ownerId,
				},
			});
			if (ok) await load(page, namespace, prefix);
			else setActionFailed(true);
		} catch {
			setActionFailed(true);
		} finally {
			setBusy(false);
			setDeleteTarget(null);
		}
	};

	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const formErrorText =
		formError === "invalid"
			? t.invalidJson
			: formError === "ttl"
				? t.invalidTtl
				: formError === "conflict"
					? t.conflict
					: formError === "save"
						? t.saveFailed
						: null;

	return (
		<PageContainer>
			<PageHeader
				title={t.title}
				description={t.description}
				actions={
					<Button size="sm" onClick={() => setForm(emptyForm(namespace))}>
						<PlusIcon className="size-4" />
						{t.newEntry}
					</Button>
				}
			/>
			{namespaces.length > 0 ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<span className="text-xs font-medium text-muted-foreground">{t.namespacesTitle}:</span>
					{namespaces.map((ns) => (
						<Badge key={ns.namespace} variant="outline">
							{ns.namespace} · {ns.count}
						</Badge>
					))}
				</div>
			) : null}
			<form
				className="mt-4 flex flex-wrap items-center gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void load(1, namespace, prefix);
				}}
			>
				<NativeSelect
					aria-label={t.allNamespaces}
					value={namespace}
					onChange={(e) => {
						const ns = e.target.value;
						setNamespace(ns);
						void load(1, ns, prefix);
					}}
				>
					<NativeSelectOption value="">{t.allNamespaces}</NativeSelectOption>
					{namespaces.map((ns) => (
						<NativeSelectOption key={ns.namespace} value={ns.namespace}>
							{ns.namespace}
						</NativeSelectOption>
					))}
				</NativeSelect>
				<SearchInput
					value={prefix}
					onChange={(e) => setPrefix(e.target.value)}
					placeholder={t.searchPlaceholder}
					aria-label={t.searchPlaceholder}
					className="w-full max-w-xs"
				/>
			</form>
			{loadFailed ? <p className="mt-3 text-sm text-destructive">{t.loadFailed}</p> : null}
			{actionFailed ? <p className="mt-3 text-sm text-destructive">{t.saveFailed}</p> : null}
			<div className="mt-4 flex items-center justify-between gap-2">
				<p className="text-sm text-muted-foreground">{t.totalCount(total)}</p>
				<div className="flex items-center gap-2">
					<span className="text-sm text-muted-foreground">{t.pageInfo(page, pages)}</span>
					<Button
						size="sm"
						variant="outline"
						disabled={page <= 1 || loading}
						onClick={() => void load(page - 1, namespace, prefix)}
					>
						{t.previous}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={page >= pages || loading}
						onClick={() => void load(page + 1, namespace, prefix)}
					>
						{t.next}
					</Button>
				</div>
			</div>
			{items.length === 0 && !loadFailed ? (
				<div className="mt-4 rounded-lg border border-dashed border-border px-6 py-10 text-center">
					<p className="text-sm font-medium">{t.emptyTitle}</p>
					<p className="mt-1 text-sm text-muted-foreground">{t.emptyDescription}</p>
				</div>
			) : items.length > 0 ? (
				<div className="mt-4 overflow-hidden rounded-lg border border-border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colKey}</TableHead>
								<TableHead>{t.colNamespace}</TableHead>
								<TableHead>{t.colScope}</TableHead>
								<TableHead>{t.colValue}</TableHead>
								<TableHead>{t.colExpiry}</TableHead>
								<TableHead>{t.colVersion}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{items.map((row) => (
								<TableRow key={JSON.stringify([row.namespace, row.key, row.tenantId, row.ownerId])}>
									<TableCell className="font-mono text-xs">{row.key}</TableCell>
									<TableCell className="font-mono text-xs">{row.namespace}</TableCell>
									<TableCell>
										{row.tenantId !== null ? (
											<Badge variant="secondary">{t.scopeTenant(row.tenantId)}</Badge>
										) : row.ownerId !== null ? (
											<Badge variant="outline">{t.scopeOwner(row.ownerId)}</Badge>
										) : (
											<Badge variant="outline">{t.scopeGlobal}</Badge>
										)}
									</TableCell>
									<TableCell className="max-w-64 truncate font-mono text-xs">
										{preview(row.value)}
									</TableCell>
									<TableCell>
										{row.expired ? (
											<Badge variant="destructive">{t.statusExpired}</Badge>
										) : row.expiresAt === null ? (
											<Badge variant="secondary">{t.statusNoExpiry}</Badge>
										) : (
											<Badge variant="outline" title={new Date(row.expiresAt).toISOString()}>
												{t.expiresIn(remainingMs(row.expiresAt))}
											</Badge>
										)}
									</TableCell>
									<TableCell className="text-muted-foreground">{row.version}</TableCell>
									<TableCell>
										<div className="flex items-center justify-end gap-1">
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													setForm(formFromRow(row));
													setFormError(null);
												}}
												aria-label={t.edit}
											>
												<PencilIcon className="size-4" />
											</Button>
											<Button
												size="sm"
												variant="ghost"
												onClick={() => {
													setDeleteTarget(row);
													setActionFailed(false);
												}}
												aria-label={t.delete}
											>
												<Trash2Icon className="size-4 text-destructive" />
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			) : null}

			<Dialog open={form !== null} onOpenChange={(open) => !open && closeFormDialog()}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{form?.mode === "edit" ? t.edit : t.create}</DialogTitle>
						<DialogDescription>{t.scopeHint}</DialogDescription>
					</DialogHeader>
					{form === null ? null : (
						<div className="flex flex-col gap-4">
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel htmlFor="kv-ns">{t.fieldNamespace}</FieldLabel>
									<Input
										id="kv-ns"
										value={form.namespace}
										disabled={form.mode === "edit"}
										onChange={(e) => patchForm({ namespace: e.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="kv-key">{t.fieldKey}</FieldLabel>
									<Input
										id="kv-key"
										value={form.key}
										disabled={form.mode === "edit"}
										onChange={(e) => patchForm({ key: e.target.value })}
									/>
								</Field>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel htmlFor="kv-tenant">{t.fieldTenantId}</FieldLabel>
									<Input
										id="kv-tenant"
										value={form.tenantId}
										disabled={form.mode === "edit"}
										onChange={(e) => patchForm({ tenantId: e.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel htmlFor="kv-owner">{t.fieldOwnerId}</FieldLabel>
									<Input
										id="kv-owner"
										value={form.ownerId}
										disabled={form.mode === "edit"}
										onChange={(e) => patchForm({ ownerId: e.target.value })}
									/>
								</Field>
							</div>
							<Field>
								<FieldLabel htmlFor="kv-value">{t.fieldValue}</FieldLabel>
								<Textarea
									id="kv-value"
									value={form.valueJson}
									onChange={(e) => patchForm({ valueJson: e.target.value })}
									rows={8}
									className="font-mono text-xs"
								/>
								<FieldDescription>{t.valueHint}</FieldDescription>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel htmlFor="kv-ttl">{t.fieldTtl}</FieldLabel>
									<NativeSelect
										id="kv-ttl"
										value={form.ttlMode}
										onChange={(e) => patchForm({ ttlMode: e.target.value as TtlMode })}
									>
										{form.mode === "edit" ? (
											<NativeSelectOption value="keep">{t.ttlKeep}</NativeSelectOption>
										) : null}
										<NativeSelectOption value="none">{t.ttlNone}</NativeSelectOption>
										<NativeSelectOption value="custom">{t.ttlCustom}</NativeSelectOption>
									</NativeSelect>
								</Field>
								{form.ttlMode === "custom" ? (
									<Field>
										<FieldLabel htmlFor="kv-ttl-sec">{t.ttlSeconds}</FieldLabel>
										<Input
											id="kv-ttl-sec"
											type="number"
											min={1}
											value={form.ttlSeconds}
											onChange={(e) => patchForm({ ttlSeconds: e.target.value })}
										/>
									</Field>
								) : null}
							</div>
							{form.mode === "edit" ? (
								<p className="text-xs text-muted-foreground">
									{t.fieldVersion}: {form.expectedVersion}
								</p>
							) : null}
							{formErrorText !== null ? (
								<p className="text-sm text-destructive">{formErrorText}</p>
							) : null}
						</div>
					)}
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								setForm(null);
								setFormError(null);
							}}
							disabled={busy}
						>
							{t.cancel}
						</Button>
						<Button onClick={() => void save()} disabled={busy}>
							{busy ? <Spinner className="size-4" /> : form?.mode === "edit" ? t.save : t.create}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => !open && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t.deleteTitle}</AlertDialogTitle>
						<AlertDialogDescription>
							{deleteTarget === null ? "" : t.deleteBody(deleteTarget.key)}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel disabled={busy}>{t.cancel}</AlertDialogCancel>
						<AlertDialogAction onClick={() => void remove()} disabled={busy}>
							{busy ? <Spinner className="size-4" /> : t.deleteConfirm}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</PageContainer>
	);
}
