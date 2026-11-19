import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { PlusIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { SearchInput } from "@ktbhealth/ui/components/search-input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Switch } from "@ktbhealth/ui/components/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import type { PanelPageContext } from "@ktb/kernel";

import {
	createFontProviderFn,
	removeFontProviderFn,
	setFontProviderEnabledFn,
	syncFontProviderFn,
} from "../fns.ts";
import { fontMessages } from "../i18n.ts";
import type { FontProviderSummary } from "../types.ts";

export interface FontProvidersPageData {
	readonly providers: readonly FontProviderSummary[];
	readonly kinds: readonly string[];
}

const KIND_TONE: Record<string, string> = {
	local: "",
	googlefonts: "",
};

/**
 * `/platform/fonts/providers` admin page — configured font sources:
 * add (kind picker fed by the registered adapter kinds), enable
 * toggle, per-provider sync and delete. Mutations go through the
 * server fns and refresh via router.invalidate (loader re-runs).
 */
export function FontProvidersPage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const t = fontMessages(ctx.locale);
	const router = useRouter();
	const payload = data as FontProvidersPageData | null;
	const providers = payload?.providers ?? [];
	const kinds = payload?.kinds ?? [];

	const [q, setQ] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [draftName, setDraftName] = useState("");
	const [draftKind, setDraftKind] = useState("");
	const [confirmDelete, setConfirmDelete] = useState<FontProviderSummary | null>(null);

	const needle = q.trim().toLowerCase();
	const filtered =
		needle === ""
			? providers
			: providers.filter((p) =>
					[p.name, p.kind, String(p.id)].join(" ").toLowerCase().includes(needle),
				);

	const refresh = () => router.invalidate();

	const openDialog = () => {
		setDraftName("");
		setDraftKind(kinds[0] ?? "");
		setDialogOpen(true);
	};

	const create = async () => {
		const name = draftName.trim();
		if (name === "" || draftKind === "" || busy !== null) return;
		setBusy("create");
		setNotice(null);
		try {
			await createFontProviderFn({ data: { kind: draftKind, name } });
			setDialogOpen(false);
			await refresh();
		} catch {
			setNotice(t.createError);
		} finally {
			setBusy(null);
		}
	};

	const toggle = async (provider: FontProviderSummary, enabled: boolean) => {
		setBusy(`toggle-${provider.id}`);
		try {
			await setFontProviderEnabledFn({ data: { id: provider.id, enabled } });
			await refresh();
		} finally {
			setBusy(null);
		}
	};

	const sync = async (provider: FontProviderSummary) => {
		setBusy(`sync-${provider.id}`);
		setNotice(null);
		try {
			await syncFontProviderFn({ data: { id: provider.id } });
			setToast({ id: Date.now(), text: t.syncedToast });
			await refresh();
		} catch {
			setNotice(t.syncError);
		} finally {
			setBusy(null);
		}
	};

	const remove = async (provider: FontProviderSummary) => {
		setBusy(`delete-${provider.id}`);
		setNotice(null);
		try {
			await removeFontProviderFn({ data: { id: provider.id } });
			setConfirmDelete(null);
			await refresh();
		} catch {
			setNotice(t.deleteError);
		} finally {
			setBusy(null);
		}
	};

	return (
		<PageContainer>
			<PageHeader
				title={t.providersTitle}
				description={t.providersDescription}
				actions={
					<Button size="sm" onClick={openDialog} disabled={busy !== null || kinds.length === 0}>
						<PlusIcon data-icon="inline-start" />
						{t.addProvider}
					</Button>
				}
			/>

			{notice !== null ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

			{providers.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.emptyProviders}</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						<Button size="sm" onClick={openDialog} disabled={kinds.length === 0}>
							<PlusIcon data-icon="inline-start" />
							{t.addProvider}
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<DataToolbar
						search={
							<SearchInput
								value={q}
								onChange={(e) => setQ(e.target.value)}
								placeholder={t.searchPlaceholder}
								aria-label={t.searchLabel}
								className="w-56 sm:w-64"
							/>
						}
						resultCount={
							q.trim() === "" ? undefined : t.filteredCount(filtered.length, providers.length)
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.colName}</TableHead>
									<TableHead>{t.colKind}</TableHead>
									<TableHead>{t.colEnabled}</TableHead>
									<TableHead>{t.colFamilies}</TableHead>
									<TableHead>{t.colUpdated}</TableHead>
									<TableHead className="text-right">{t.colActions}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{filtered.length === 0 ? (
									<TableRow>
										<TableCell colSpan={6} className="text-xs text-muted-foreground">
											{t.noResults}
										</TableCell>
									</TableRow>
								) : (
									filtered.map((provider) => (
										<TableRow key={provider.id}>
											<TableCell className="text-sm font-medium">{provider.name}</TableCell>
											<TableCell>
												<Badge variant="secondary" className={KIND_TONE[provider.kind]}>
													{provider.kind}
												</Badge>
											</TableCell>
											<TableCell>
												<Switch
													checked={provider.enabled}
													disabled={busy !== null}
													onCheckedChange={(checked) => void toggle(provider, checked === true)}
													aria-label={provider.name}
												/>
											</TableCell>
											<TableCell className="text-sm tabular-nums">{provider.familyCount}</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{provider.updatedAt ?? provider.createdAt}
											</TableCell>
											<TableCell className="text-right">
												<div className="flex justify-end gap-1">
													<Button
														variant="ghost"
														size="sm"
														onClick={() => void sync(provider)}
														disabled={busy !== null}
													>
														{busy === `sync-${provider.id}` ? (
															<Spinner className="size-3.5" />
														) : (
															<RefreshCwIcon className="size-3.5" />
														)}
														{busy === `sync-${provider.id}` ? t.syncing : t.sync}
													</Button>
													<Button
														variant="ghost"
														size="sm"
														onClick={() => setConfirmDelete(provider)}
														disabled={busy !== null}
													>
														<Trash2Icon className="size-3.5" />
														{t.deleteProvider}
													</Button>
												</div>
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>
				</>
			)}

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t.dialogAddTitle}</DialogTitle>
						<DialogDescription>{t.providersDescription}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<label className="text-sm">
							{t.nameLabel}
							<Input
								value={draftName}
								onChange={(e) => setDraftName(e.target.value)}
								placeholder={t.namePlaceholder}
							/>
						</label>
						<label className="text-sm">
							{t.kindLabel}
							<Select
								items={kinds.map((k) => ({ value: k, label: k }))}
								value={draftKind}
								onValueChange={(v) => setDraftKind(String(v))}
							>
								<SelectTrigger className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{kinds.map((k) => (
										<SelectItem key={k} value={k}>
											{k}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</label>
						<div className="flex gap-2">
							<Button
								onClick={() => void create()}
								disabled={busy !== null || draftName.trim() === ""}
							>
								{busy === "create" ? <Spinner className="size-4" /> : null}
								{busy === "create" ? t.creating : t.create}
							</Button>
							<Button variant="outline" onClick={() => setDialogOpen(false)}>
								{t.cancel}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>

			{confirmDelete !== null ? (
				<ConfirmDialog
					open
					onOpenChange={(open) => {
						if (!open) setConfirmDelete(null);
					}}
					title={t.deleteProvider}
					description={t.deleteConfirm}
					confirmLabel={t.deleteProvider}
					variant="destructive"
					loading={busy === `delete-${confirmDelete.id}`}
					onConfirm={() => void remove(confirmDelete)}
				/>
			) : null}

			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}
