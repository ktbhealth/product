import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { UsersIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { viewsMessages } from "@ktb/views";
import {
	ConfirmAction,
	SearchInput,
	TablePage,
	useTableQuery,
	type Column,
} from "@ktb/views/table";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
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

import type { TenantMember, TenantRow } from "../index.ts";
import {
	addTenantMemberFn,
	listTenantMembersFn,
	removeTenantMemberFn,
	setTenantMemberRoleFn,
} from "../fns.ts";
import { tenantMessages, type TenantMessages, I18N_NAMESPACE } from "../i18n.ts";

const inputCls =
	"h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Built-in tenant roles — mirrors `TenantRole` in @ktb/tenant. The
 * stored `group_members.role` is free-form, so a non-standard value is
 * rendered as an extra select option instead of being rewritten. */
const TENANT_ROLES = ["owner", "admin", "member"] as const;
type TenantRoleValue = (typeof TENANT_ROLES)[number];

const isTenantRole = (value: string | null): value is TenantRoleValue =>
	value !== null && (TENANT_ROLES as readonly string[]).includes(value);

const roleItems = (t: TenantMessages) =>
	[
		{ value: "owner", label: t.roleOwner },
		{ value: "admin", label: t.roleAdmin },
		{ value: "member", label: t.roleMember },
	] as const;

/**
 * /platform/tenants console view — cross-owner tenant listing for
 * platform admins. Tenants are groups; this page manages memberships
 * and roles only (group CRUD lives on /platform/groups). Dense/
 * utilitarian by design (system console). Mutations go through the
 * plugin's server fns; the loader re-runs on `router.invalidate()`.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `useTableQuery` client-side search — the row action opens
 * the members dialog rather than running a mutation, and the empty
 * state replaces the whole table block (toolbar included) instead of
 * rendering inside it.
 */
export function AdminTenantsPage({
	tenants,
	i18n,
	locale = "en",
}: {
	tenants: TenantRow[];
	/** Active UI locale, injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, tenantMessages(locale));
	const [membersFor, setMembersFor] = useState<TenantRow | null>(null);

	// Same predicate as before: case-insensitive substring over the
	// name + slug pair.
	const query = useTableQuery<TenantRow>({
		rows: tenants,
		search: {
			predicate: (tenant, needle) =>
				[tenant.name, tenant.slug].filter(Boolean).join(" ").toLowerCase().includes(needle),
		},
	});

	const columns: readonly Column<TenantRow>[] = [
		{
			key: "id",
			header: t.colId,
			width: "3.5rem",
			render: (tenant) => <span className="text-xs text-muted-foreground">{tenant.id}</span>,
		},
		{
			key: "name",
			header: t.colName,
			render: (tenant) => <span className="font-medium">{tenant.name}</span>,
		},
		{
			key: "slug",
			header: t.colSlug,
			render: (tenant) => <span className="text-xs">{tenant.slug}</span>,
		},
		{ key: "kind", header: t.colKind },
		{
			key: "memberCount",
			header: t.colMembers,
			align: "right",
			render: (tenant) => <span className="text-xs">{tenant.memberCount}</span>,
		},
		{ key: "createdAt", header: t.colCreated, align: "right", format: "datetime" },
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (tenant) => (
				<Button type="button" variant="ghost" size="sm" onClick={() => setMembersFor(tenant)}>
					<UsersIcon className="size-3.5" /> {t.colMembers}
				</Button>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={t.title}
				description={tenants.length === 0 ? t.none : t.count(tenants.length)}
			/>
			{tenants.length === 0 ? null : (
				<TablePage.Toolbar
					search={
						<SearchInput
							value={query.q}
							onChange={query.setQ}
							placeholder={t.searchPlaceholder}
							aria-label={t.searchLabel}
						/>
					}
					resultCount={query.isFiltered ? t.filteredCount(query.shown, query.total) : undefined}
				/>
			)}
			<TablePage.Table
				columns={columns}
				rows={query.rows}
				total={query.total}
				isFiltered={query.isFiltered}
				locale={locale}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
				noMatch={t.noMatch}
			/>
			{membersFor !== null ? (
				<TenantMembersDialog
					key={membersFor.id}
					tenant={membersFor}
					t={t}
					onClose={() => setMembersFor(null)}
				/>
			) : null}
		</TablePage>
	);
}

/** Members dialog — lists user memberships, adds users, changes roles,
 * removes memberships for one tenant.
 *
 * `CollectionDialog` does not fit: its confirm copy is static (no
 * per-row description like `removeMemberDescription(memberId)`), its
 * column `render` receives no `{ busy, error, reload }` context (the
 * role `<Select>` needs `busy`), and `remove` never calls
 * `router.invalidate()`. The dialog therefore composes kit primitives
 * directly: `TablePage.Table` for the member list and `ConfirmAction`
 * for the destructive remove. */
function TenantMembersDialog({
	tenant,
	t,
	onClose,
}: {
	tenant: TenantRow;
	t: TenantMessages;
	onClose: () => void;
}) {
	const router = useRouter();
	const [members, setMembers] = useState<TenantMember[] | null>(null);
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [memberId, setMemberId] = useState("");
	const [role, setRole] = useState<TenantRoleValue>("member");

	const load = useCallback(async () => {
		const res = await listTenantMembersFn({ data: { tenantId: tenant.id } });
		if (res.ok) {
			setMembers([...res.data]);
		} else {
			setMembers([]);
			setError(true);
		}
	}, [tenant.id]);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (fn: () => Promise<{ ok: boolean }>) => {
		setBusy(true);
		setError(false);
		try {
			const res = await fn();
			if (!res.ok) setError(true);
			await router.invalidate();
			return res;
		} finally {
			setBusy(false);
		}
	};

	const addMember = async () => {
		const id = memberId.trim();
		if (id === "") return;
		await run(async () => {
			const res = await addTenantMemberFn({
				data: { tenantId: tenant.id, memberId: id, role },
			});
			if (res.ok) setMemberId("");
			await load();
			return res;
		});
	};

	const changeRole = async (target: TenantMember, next: string) => {
		// Only the built-in roles are writable — a stored free-form value
		// is display-only until the admin picks a real tenant role.
		if (!isTenantRole(next)) return;
		if (next === (target.role ?? "member")) return;
		await run(async () => {
			const res = await setTenantMemberRoleFn({
				data: { tenantId: tenant.id, memberId: target.memberId, role: next },
			});
			await load();
			return res;
		});
	};

	const confirmRemove = async (target: TenantMember) => {
		await run(async () => {
			const res = await removeTenantMemberFn({
				data: { tenantId: tenant.id, memberId: target.memberId },
			});
			await load();
			return res;
		});
	};

	const memberColumns: readonly Column<TenantMember>[] = [
		{
			key: "memberId",
			header: t.colMember,
			render: (m) => <span className="font-mono text-xs">{m.memberId}</span>,
		},
		{
			key: "role",
			header: t.colRole,
			render: (m) => {
				// Free-form stored roles outside the built-in
				// set stay selectable-as-current but are not
				// offered as new values.
				const items =
					m.role !== null && !isTenantRole(m.role)
						? [...roleItems(t), { value: m.role, label: m.role }]
						: roleItems(t);
				return (
					<Select
						items={items}
						value={m.role ?? "member"}
						onValueChange={(v) => void changeRole(m, v as string)}
						disabled={busy}
					>
						<SelectTrigger aria-label={`${t.colRole} ${m.memberId}`} className="h-7 w-28 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{items.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				);
			},
		},
		{
			key: "actions",
			header: t.colActions,
			align: "right",
			render: (m) => (
				<ConfirmAction
					trigger={
						<Button type="button" variant="ghost" size="sm" disabled={busy}>
							{t.removeMember}
						</Button>
					}
					title={t.removeMemberTitle}
					description={t.removeMemberDescription(m.memberId)}
					confirmLabel={t.removeMember}
					cancelLabel={t.cancel}
					variant="destructive"
					onConfirm={() => confirmRemove(m)}
				/>
			),
		},
	];

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle>{t.membersTitle}</DialogTitle>
					<DialogDescription>
						{tenant.name} · {tenant.slug}
					</DialogDescription>
				</DialogHeader>
				{error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
				{members === null ? (
					<p className="text-xs text-muted-foreground">{t.membersLoading}</p>
				) : members.length === 0 ? (
					<p className="text-xs text-muted-foreground">{t.membersEmpty}</p>
				) : (
					<TablePage.Table
						className="max-h-64 overflow-y-auto"
						columns={memberColumns}
						rows={members}
					/>
				)}
				<form
					className="flex flex-wrap items-end gap-2"
					onSubmit={(e) => {
						e.preventDefault();
						void addMember();
					}}
				>
					<Field className="min-w-40 flex-1">
						<FieldLabel htmlFor="member-id">{t.colMember}</FieldLabel>
						<Input
							id="member-id"
							className={inputCls}
							placeholder={t.memberIdPlaceholder}
							value={memberId}
							onChange={(e) => setMemberId(e.target.value)}
						/>
					</Field>
					<Field className="w-32">
						<FieldLabel htmlFor="member-role">{t.colRole}</FieldLabel>
						<Select
							items={roleItems(t)}
							value={role}
							onValueChange={(v) => setRole(v as TenantRoleValue)}
						>
							<SelectTrigger id="member-role" aria-label={t.colRole} className="h-8 text-xs">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{roleItems(t).map((item) => (
									<SelectItem key={item.value} value={item.value}>
										{item.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</Field>
					<Button type="submit" size="sm" disabled={busy}>
						{t.addMember}
					</Button>
				</form>
			</DialogContent>
		</Dialog>
	);
}
