import { useMemo, useState } from "react";
import { PlusIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";
import { ConfirmAction, TablePage, useServerMutation, type Column } from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import type { AdminRbacPageData, AssignmentRow, RoleDetailWire, RoleWire } from "../index.ts";
import {
	assignSubjectFn,
	createRoleFn,
	deleteRoleFn,
	revokeRolePermissionFn,
	setRolePermissionFn,
	unassignSubjectFn,
	updateRoleFn,
} from "../fns.ts";
import { rbacMessages, type RbacMessages, I18N_NAMESPACE } from "../i18n.ts";

const inputCls =
	"h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

const permKey = (resource: string, action: string) => `${resource}.${action}`;

const KIND_ITEMS = [
	{ value: "user", label: "user" },
	{ value: "group", label: "group" },
] as const;

type CatalogEntry = AdminRbacPageData["catalog"][number];

/**
 * /platform/roles console (P-054): role list + create/delete, a
 * permission-matrix editor per role (cycle none → allow → deny → none),
 * and subject assignments (user/group × role, optional tenant scope and
 * expiry). Mutations go through the plugin's server fns; the loader
 * re-runs on `router.invalidate()`.
 *
 * Built on the shared table kit (`@ktb/views/table`): the three
 * sections render through `TablePage.Table` columns, deletes/
 * unassigns go through `ConfirmAction`, and every server fn funnels
 * through one `useServerMutation` slot so busy/error/invalidate behave
 * like the old `run()` helper. The edit-role dialog stays plugin-local
 * — `FormDialog` cannot pre-fill fields.
 */
export function AdminRbacPage({
	data,
	i18n,
	locale = "en",
}: {
	data: AdminRbacPageData;
	/** Active UI locale, injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, rbacMessages(locale));
	const [selectedId, setSelectedId] = useState<number | null>(data.roles[0]?.id ?? null);
	const [editing, setEditing] = useState<RoleWire | null>(null);
	const [newName, setNewName] = useState("");
	const [newDesc, setNewDesc] = useState("");
	const [assign, setAssign] = useState<{
		subjectKind: "user" | "group";
		subjectId: string;
		roleId: string | null;
		tenantId: string;
		expiresAt: string;
	}>({
		subjectKind: "user",
		subjectId: "",
		roleId: null,
		tenantId: "",
		expiresAt: "",
	});

	// One mutation slot for the whole console: every server fn funnels
	// through `call` so `busy`/`error`/`router.invalidate()` match the
	// previous `run()` helper (success invalidates; failure flags
	// `error` — the kit does not invalidate on failure).
	const mutation = useServerMutation<{ call: () => Promise<unknown> }>((args) => args.data.call());
	const busy = mutation.busy;
	const error = mutation.error;
	const run = (call: () => Promise<unknown>) => mutation.mutate({ call });

	const detail = useMemo<RoleDetailWire | null>(
		() => data.details.find((d) => d.role.id === selectedId) ?? null,
		[data.details, selectedId],
	);
	const grants = useMemo(() => {
		const m = new Map<string, "allow" | "deny">();
		for (const p of detail?.permissions ?? []) m.set(permKey(p.resource, p.action), p.effect);
		return m;
	}, [detail]);
	// Base UI models "nothing selected" as null — the form state keeps "".
	const roleItems = useMemo(
		() => [
			{ value: null, label: t.selectRole },
			...data.roles.map((r) => ({ value: String(r.id), label: r.name })),
		],
		[data.roles, t.selectRole],
	);

	const cycleEffect = (resource: string, action: string) => {
		/* v8 ignore next -- the matrix button only renders when detail is non-null */
		if (!detail) return;
		const key = permKey(resource, action);
		const current = grants.get(key);
		const next = current === undefined ? "allow" : current === "allow" ? "deny" : undefined;
		void run(() =>
			next === undefined
				? revokeRolePermissionFn({
						data: { roleId: detail.role.id, resource, action },
					})
				: setRolePermissionFn({
						data: { roleId: detail.role.id, resource, action, effect: next },
					}),
		);
	};

	const roleColumns: Column<RoleWire>[] = [
		{
			key: "name",
			header: t.roleName,
			render: (r) => <span className="font-medium">{r.name}</span>,
		},
		{
			key: "description",
			header: t.roleDescription,
			render: (r) => <span className="text-xs text-muted-foreground">{r.description ?? "—"}</span>,
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (r) => (
				<>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						aria-label={t.editRole}
						onClick={() => setEditing(r)}
					>
						<PencilIcon className="size-3.5" />
					</Button>
					<ConfirmAction
						trigger={(open) => (
							<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={open}>
								<Trash2Icon className="size-3.5" /> {t.deleteRole}
							</Button>
						)}
						title={t.deleteRoleTitle}
						description={t.deleteRoleDescription(r.name)}
						confirmLabel={t.deleteRole}
						cancelLabel={t.cancel}
						variant="destructive"
						onConfirm={() => run(() => deleteRoleFn({ data: { id: r.id } }))}
					/>
				</>
			),
		},
	];

	const permissionColumns: Column<CatalogEntry>[] = [
		{
			key: "key",
			header: t.colPermission,
			render: (c) => <span className="font-mono text-xs">{c.key}</span>,
		},
		{
			key: "effect",
			header: t.colEffect,
			align: "right",
			render: (c) => {
				const effect = grants.get(c.key);
				return (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => cycleEffect(c.resource, c.action)}
					>
						<Badge
							variant={
								effect === "allow" ? "default" : effect === "deny" ? "destructive" : "outline"
							}
						>
							{effect === undefined
								? t.effectNone
								: effect === "allow"
									? t.effectAllow
									: t.effectDeny}
						</Badge>
					</Button>
				);
			},
		},
	];

	const assignmentColumns: Column<AssignmentRow>[] = [
		{
			key: "subjectKind",
			header: t.colSubject,
			render: (a) => <Badge variant="outline">{a.subjectKind}</Badge>,
		},
		{
			key: "subjectId",
			header: t.colSubjectId,
			render: (a) => <span className="font-mono text-xs">{a.subjectId}</span>,
		},
		{ key: "roleName", header: t.colRole },
		{
			key: "tenantId",
			header: t.colTenant,
			render: (a) => <span className="text-xs">{a.tenantId ?? t.globalTenant}</span>,
		},
		{
			key: "expiresAt",
			header: t.colExpires,
			render: (a) => (
				<span className="text-xs">
					<LocalDateTime
						value={a.expiresAt}
						locale={locale}
						fallback={a.expiresAt === null ? t.neverExpires : null}
					/>
				</span>
			),
		},
		{
			key: "grantedBy",
			header: t.colGrantedBy,
			render: (a) => <span className="text-xs text-muted-foreground">{a.grantedBy ?? "—"}</span>,
		},
		{
			key: "unassign",
			header: t.unassign,
			align: "right",
			render: (a) => (
				<ConfirmAction
					trigger={(open) => (
						<Button type="button" variant="ghost" size="sm" disabled={busy} onClick={open}>
							{t.unassign}
						</Button>
					)}
					title={t.unassignTitle}
					description={t.unassignDescription(a.subjectId, a.roleName)}
					confirmLabel={t.unassign}
					cancelLabel={t.cancel}
					variant="destructive"
					onConfirm={() => run(() => unassignSubjectFn({ data: { id: a.id } }))}
				/>
			),
		},
	];

	return (
		<TablePage>
			<TablePage.Header title={t.title} description={t.subtitle} />
			{error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
			{/* The kit root spaces children with gap-4; the sections keep
			 * their original space-y-8 rhythm inside this wrapper. */}
			<div className="space-y-8">
				<section>
					<h2 className="text-sm font-semibold">{t.rolesTitle}</h2>
					<form
						className="mt-2 flex items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (newName.trim() === "") return;
							void run(async () => {
								const res = await createRoleFn({
									data: { name: newName.trim(), description: newDesc.trim() || null },
								});
								if (res.ok) {
									setNewName("");
									setNewDesc("");
								}
								return res;
							});
						}}
					>
						<Input
							className={inputCls}
							placeholder={t.roleName}
							value={newName}
							onChange={(e) => setNewName(e.target.value)}
						/>
						<Input
							className={inputCls}
							placeholder={t.roleDescription}
							value={newDesc}
							onChange={(e) => setNewDesc(e.target.value)}
						/>
						<Button type="submit" size="sm" disabled={busy}>
							<PlusIcon className="size-3.5" /> {t.createRole}
						</Button>
					</form>
					{data.roles.length === 0 ? (
						<p className="mt-3 text-xs text-muted-foreground">{t.rolesEmpty}</p>
					) : (
						<TablePage.Table
							className="mt-3"
							columns={roleColumns}
							rows={data.roles}
							rowKey={(r) => String(r.id)}
							locale={locale}
							onRowClick={(r) => setSelectedId(r.id)}
							// `data-state="selected"` on the old TableRow mapped to
							// `bg-muted` — rowClassName is the kit's only hook.
							rowClassName={(r) => (r.id === selectedId ? "bg-muted" : undefined)}
						/>
					)}
				</section>

				<section>
					<h2 className="text-sm font-semibold">{t.permissionsTitle}</h2>
					{detail === null ? (
						<p className="mt-2 text-xs text-muted-foreground">
							{data.roles.length === 0 ? t.matrixEmpty : t.selectRole}
						</p>
					) : data.catalog.length === 0 ? null : (
						<TablePage.Table
							className="mt-3"
							columns={permissionColumns}
							rows={data.catalog}
							rowKey={(c) => c.key}
							locale={locale}
						/>
					)}
				</section>

				<section>
					<h2 className="text-sm font-semibold">{t.assignmentsTitle}</h2>
					<form
						className="mt-2 flex flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (assign.subjectId.trim() === "" || assign.roleId === null) return;
							void run(() =>
								assignSubjectFn({
									data: {
										subjectKind: assign.subjectKind,
										subjectId: assign.subjectId.trim(),
										roleId: Number(assign.roleId),
										tenantId: assign.tenantId.trim() === "" ? null : assign.tenantId.trim(),
										expiresAt:
											assign.expiresAt === "" ? null : new Date(assign.expiresAt).toISOString(),
									},
								}),
							);
						}}
					>
						<Select
							items={KIND_ITEMS}
							value={assign.subjectKind}
							onValueChange={(v) => setAssign({ ...assign, subjectKind: v as "user" | "group" })}
						>
							<SelectTrigger aria-label={t.subjectKind} className="h-8 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{KIND_ITEMS.map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							className={inputCls}
							placeholder={t.subjectId}
							value={assign.subjectId}
							onChange={(e) => setAssign({ ...assign, subjectId: e.target.value })}
						/>
						<Select
							items={roleItems}
							value={assign.roleId}
							onValueChange={(v) => setAssign({ ...assign, roleId: v })}
						>
							<SelectTrigger aria-label={t.colRole} className="h-8 max-w-56 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{roleItems.map((item) => (
									<SelectItem key={item.value ?? ""} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							className={inputCls}
							placeholder={t.tenantId}
							value={assign.tenantId}
							onChange={(e) => setAssign({ ...assign, tenantId: e.target.value })}
						/>
						<Input
							className={inputCls}
							type="datetime-local"
							value={assign.expiresAt}
							onChange={(e) => setAssign({ ...assign, expiresAt: e.target.value })}
							aria-label={t.expiresAt}
						/>
						<Button type="submit" size="sm" disabled={busy}>
							{t.assignSubject}
						</Button>
					</form>
					{data.assignments.length === 0 ? (
						<p className="mt-3 text-xs text-muted-foreground">{t.assignmentsEmpty}</p>
					) : (
						<TablePage.Table
							className="mt-3"
							columns={assignmentColumns}
							rows={data.assignments}
							rowKey={(a) => String(a.id)}
							locale={locale}
						/>
					)}
				</section>
			</div>
			{editing !== null ? (
				<EditRoleDialog key={editing.id} role={editing} t={t} onClose={() => setEditing(null)} />
			) : null}
		</TablePage>
	);
}

/** Edit-role dialog — name/description/meta, pre-filled from the row. */
function EditRoleDialog({
	role,
	t,
	onClose,
}: {
	role: RoleWire;
	t: RbacMessages;
	onClose: () => void;
}) {
	const [form, setForm] = useState({
		name: role.name,
		description: role.description ?? "",
		meta: role.meta ?? "",
	});
	const update = useServerMutation<{
		id: number;
		name: string;
		description: string | null;
		meta: string | null;
	}>(updateRoleFn);

	const submit = async () => {
		const name = form.name.trim();
		if (name === "") return;
		const ok = await update.mutate({
			id: role.id,
			name,
			description: form.description.trim() === "" ? null : form.description.trim(),
			meta: form.meta.trim() === "" ? null : form.meta.trim(),
		});
		if (ok) onClose();
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				/* v8 ignore next -- mounted only while editing; only close events fire */
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.editRoleTitle}</DialogTitle>
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<Field>
						<FieldLabel htmlFor="edit-role-name">{t.roleName}</FieldLabel>
						<Input
							id="edit-role-name"
							className={inputCls}
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="edit-role-description">{t.roleDescription}</FieldLabel>
						<Input
							id="edit-role-description"
							className={inputCls}
							value={form.description}
							onChange={(e) => setForm({ ...form, description: e.target.value })}
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="edit-role-meta">{t.roleMeta}</FieldLabel>
						<Input
							id="edit-role-meta"
							className={inputCls}
							placeholder={t.metaPlaceholder}
							value={form.meta}
							onChange={(e) => setForm({ ...form, meta: e.target.value })}
						/>
					</Field>
					{update.error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" onClick={onClose}>
							{t.cancel}
						</Button>
						<Button type="submit" size="sm" disabled={update.busy}>
							{t.editRoleSubmit}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
