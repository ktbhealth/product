import { useState } from "react";
import { PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { LocalDateTime } from "@ktb/views/views";
import {
	CollectionDialog,
	ConfirmAction,
	FormDialog,
	SearchInput,
	TablePage,
	useServerMutation,
	useTableQuery,
	type CollectionDialogAddContext,
	type Column,
} from "@ktb/views/table";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import type {
	AddGroupMemberInput,
	AdminGroupRow,
	GroupMember,
	RemoveGroupMemberInput,
} from "../index.ts";
import {
	addGroupMemberFn,
	createGroupFn,
	deleteGroupFn,
	listGroupMembersFn,
	removeGroupMemberFn,
} from "../fns.ts";
import { groupMessages, type GroupMessages, I18N_NAMESPACE } from "../i18n.ts";

const inputCls =
	"h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

const MEMBER_KIND_ITEMS = [
	{ value: "user", label: "user" },
	{ value: "group", label: "group" },
] as const;

/**
 * /platform/groups console view — cross-owner group listing for
 * platform admins. Dense/utilitarian by design (system console).
 * Mutations go through the plugin's server fns via the shared
 * `@ktb/views/table` kit (`TablePage` shell, `useTableQuery` search,
 * `useServerMutation` invalidate plumbing, `FormDialog`/`ConfirmAction`/
 * `CollectionDialog`); the loader re-runs on `router.invalidate()`.
 */
export function AdminGroupsPage({
	groups,
	i18n,
	locale = "en",
}: {
	groups: AdminGroupRow[];
	/** Active UI locale, injected by the host via the panel page ctx. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, groupMessages(locale));
	const query = useTableQuery<AdminGroupRow>({
		rows: groups,
		search: { keys: ["name", "slug"] },
	});
	const del = useServerMutation<{ id: number }>(deleteGroupFn);
	const [createOpen, setCreateOpen] = useState(false);
	const [membersFor, setMembersFor] = useState<AdminGroupRow | null>(null);

	const columns: Column<AdminGroupRow>[] = [
		{
			key: "id",
			header: t.colId,
			width: "3.5rem",
			render: (g) => <span className="text-xs text-muted-foreground">{g.id}</span>,
		},
		{
			key: "name",
			header: t.colName,
			render: (g) => <span className="font-medium">{g.name}</span>,
		},
		{
			key: "slug",
			header: t.colSlug,
			render: (g) => <span className="text-xs">{g.slug}</span>,
		},
		{ key: "kind", header: t.colKind },
		{
			key: "memberCount",
			header: t.colMembers,
			align: "right",
			render: (g) => <span className="text-xs">{g.memberCount}</span>,
		},
		{
			key: "createdAt",
			header: t.colCreated,
			align: "right",
			render: (g) => (
				<span className="text-muted-foreground">
					<LocalDateTime value={g.createdAt} locale={locale} />
				</span>
			),
		},
	];

	const rowActions = (g: AdminGroupRow) => (
		<>
			<Button type="button" variant="ghost" size="sm" onClick={() => setMembersFor(g)}>
				<UsersIcon className="size-3.5" /> {t.colMembers}
			</Button>
			<ConfirmAction
				trigger={(open) => (
					<Button type="button" variant="ghost" size="sm" onClick={open}>
						<Trash2Icon className="size-3.5" /> {t.deleteGroup}
					</Button>
				)}
				title={t.deleteGroupTitle}
				description={t.deleteGroupDescription(g.name)}
				confirmLabel={t.confirmDelete}
				cancelLabel={t.cancel}
				variant="destructive"
				onConfirm={() => del.mutate({ id: g.id })}
			/>
		</>
	);

	return (
		<TablePage>
			<TablePage.Header
				title={t.title}
				description={groups.length === 0 ? t.none : t.count(groups.length)}
				actions={
					<Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
						<PlusIcon className="size-3.5" /> {t.newGroup}
					</Button>
				}
			/>
			{del.error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
			{groups.length === 0 ? null : (
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
				total={groups.length}
				isFiltered={query.isFiltered}
				empty={{ title: t.emptyTitle, description: t.emptyDescription }}
				noMatch={t.noMatch}
				locale={locale}
				rowActions={rowActions}
			/>
			{createOpen ? (
				<CreateGroupDialog open={createOpen} onOpenChange={setCreateOpen} t={t} />
			) : null}
			{membersFor !== null ? (
				<GroupMembersDialog
					key={membersFor.id}
					group={membersFor}
					t={t}
					locale={locale}
					onClose={() => setMembersFor(null)}
				/>
			) : null}
		</TablePage>
	);
}

/** Create-group dialog — name/slug/kind are required, meta optional. */
function CreateGroupDialog({
	open,
	onOpenChange,
	t,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	t: GroupMessages;
}) {
	const create = useServerMutation<{
		name: string;
		slug: string;
		kind: string;
		meta: string | null;
	}>(createGroupFn);

	return (
		<FormDialog
			open={open}
			onOpenChange={onOpenChange}
			title={t.createTitle}
			fields={[
				{ name: "name", label: t.fieldName, placeholder: t.namePlaceholder, required: true },
				{ name: "slug", label: t.fieldSlug, placeholder: t.slugPlaceholder, required: true },
				{ name: "kind", label: t.fieldKind, placeholder: t.kindPlaceholder, required: true },
				{ name: "meta", label: t.fieldMeta, placeholder: t.metaPlaceholder },
			]}
			submitLabel={t.createSubmit}
			cancelLabel={t.cancel}
			loading={create.busy}
			error={create.error ? t.saveError : undefined}
			onSubmit={async (values) => {
				const meta = values.meta ?? "";
				return create.mutate({
					name: values.name ?? "",
					slug: values.slug ?? "",
					kind: values.kind ?? "",
					meta: meta === "" ? null : meta,
				});
			}}
		/>
	);
}

/** Members dialog — lists memberships, adds/removes them for one group. */
function GroupMembersDialog({
	group,
	t,
	locale,
	onClose,
}: {
	group: AdminGroupRow;
	t: GroupMessages;
	locale: string;
	onClose: () => void;
}) {
	const removeMember = useServerMutation<RemoveGroupMemberInput>(removeGroupMemberFn);

	const columns: Column<GroupMember>[] = [
		{
			key: "memberKind",
			header: t.memberKindLabel,
			render: (m) => <Badge variant="outline">{m.memberKind}</Badge>,
		},
		{
			key: "memberId",
			header: t.colMember,
			render: (m) => <span className="font-mono text-xs">{m.memberId}</span>,
		},
		{
			key: "role",
			header: t.colRole,
			render: (m) => <span className="text-xs">{m.role ?? "—"}</span>,
		},
	];

	return (
		<CollectionDialog
			open
			onOpenChange={(open) => {
				if (!open) onClose();
			}}
			title={t.membersTitle}
			description={`${group.name} · ${group.slug}`}
			columns={columns}
			locale={locale}
			load={() => listGroupMembersFn({ data: { groupId: group.id } })}
			remove={(m) =>
				removeMember.mutate({
					groupId: group.id,
					memberKind: m.memberKind,
					memberId: m.memberId,
				})
			}
			removeDescription={(m) => t.removeMemberDescription(m.memberId)}
			messages={{
				loading: t.membersLoading,
				empty: t.membersEmpty,
				error: t.saveError,
				remove: t.removeMember,
				removeTitle: t.removeMemberTitle,
				removeConfirm: t.removeMember,
				cancel: t.cancel,
			}}
			addForm={(ctx) => <AddMemberForm group={group} t={t} ctx={ctx} />}
		/>
	);
}

/** Add-member row inside {@link GroupMembersDialog} — kind select plus
 * member id/role inputs; reloads the collection on success. */
function AddMemberForm({
	group,
	t,
	ctx,
}: {
	group: AdminGroupRow;
	t: GroupMessages;
	ctx: CollectionDialogAddContext;
}) {
	const addMember = useServerMutation<AddGroupMemberInput>(addGroupMemberFn);
	const [memberKind, setMemberKind] = useState<"user" | "group">("user");
	const [memberId, setMemberId] = useState("");
	const [role, setRole] = useState("");

	const submit = async () => {
		const id = memberId.trim();
		if (id === "") return;
		const r = role.trim();
		const ok = await addMember.mutate({
			groupId: group.id,
			memberKind,
			memberId: id,
			role: r === "" ? null : r,
		});
		if (ok) {
			setMemberId("");
			setRole("");
			await ctx.reload();
		}
	};

	return (
		<>
			{addMember.error ? <p className="text-xs text-destructive">{t.saveError}</p> : null}
			<form
				className="flex flex-wrap items-end gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					void submit();
				}}
			>
				<Field className="w-28">
					<FieldLabel htmlFor="member-kind">{t.memberKindLabel}</FieldLabel>
					<Select
						items={MEMBER_KIND_ITEMS}
						value={memberKind}
						onValueChange={(v) => setMemberKind(v as "user" | "group")}
					>
						<SelectTrigger id="member-kind" aria-label={t.memberKindLabel} className="h-8 text-xs">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{MEMBER_KIND_ITEMS.map((item) => (
								<SelectItem key={item.value} value={item.value}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</Field>
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
				<Field className="min-w-32 flex-1">
					<FieldLabel htmlFor="member-role">{t.colRole}</FieldLabel>
					<Input
						id="member-role"
						className={inputCls}
						placeholder={t.rolePlaceholder}
						value={role}
						onChange={(e) => setRole(e.target.value)}
					/>
				</Field>
				<Button type="submit" size="sm" disabled={addMember.busy || ctx.busy}>
					{t.addMember}
				</Button>
			</form>
		</>
	);
}
