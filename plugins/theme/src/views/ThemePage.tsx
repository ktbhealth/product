import { useState } from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { PencilIcon, PlusIcon, StarIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";
import { DataToolbar } from "@ktbhealth/ui/components/data-toolbar";
import { Empty, EmptyContent, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { SearchInput } from "@ktbhealth/ui/components/search-input";
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
	deleteThemeFn,
	publishThemeFn,
	setThemeEnabledFn,
	setThemeMainFn,
	setThemePreviewFn,
} from "../fns.ts";
import { themeMessages, type ThemeMessages } from "../i18n.ts";
import type { ThemeScopeKind, ThemeSummary } from "../types.ts";

export interface ThemePageData {
	readonly themes: readonly ThemeSummary[];
}

const brandNameOf = (theme: ThemeSummary): string | null =>
	theme.appName ?? theme.brand?.appName ?? null;

const scopeLabel = (scope: ThemeScopeKind, t: ThemeMessages): string =>
	scope === "platform"
		? t.scopePlatform
		: scope === "tenant"
			? t.scopeTenant
			: t.scopePortalInstance;

/**
 * `/platform/theme` admin page — list view of defined themes with
 * Preview / Set main / Edit / Delete row actions. The main row
 * (resolve()'s last fallback) carries a badge and cannot be deleted.
 * "New theme" auto-creates a draft row (tenant scope, generated
 * scopeId) and navigates to `/platform/theme/editor`; the editor
 * deletes untouched drafts on the way out, flagging the discard via
 * `sessionStorage` so this page can show a toast on return.
 */
export function ThemePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const t = themeMessages(ctx.locale);
	const router = useRouter();
	const navigate = useNavigate();
	const themes = ((data as ThemePageData | null)?.themes ?? []) as readonly ThemeSummary[];

	const [q, setQ] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ThemeSummary | null>(null);
	// The editor sets this flag when it deletes an untouched draft —
	// read once at mount (lazy init keeps this out of an effect).
	const [toast, setToast] = useState<ToastData | null>(() => {
		try {
			if (sessionStorage.getItem("ktb-theme-discarded") === "1") {
				sessionStorage.removeItem("ktb-theme-discarded");
				return { id: Date.now(), text: t.discardedToast };
			}
		} catch {
			/* storage unavailable */
		}
		return null;
	});

	const needle = q.trim().toLowerCase();
	const filtered =
		needle === ""
			? themes
			: themes.filter((theme) =>
					[
						theme.appName ?? "",
						theme.brand?.appName ?? "",
						scopeLabel(theme.scope, t),
						theme.scopeId,
						String(theme.id),
					]
						.join(" ")
						.toLowerCase()
						.includes(needle),
				);

	const createTheme = async () => {
		if (busy !== null) return;
		setBusy("create");
		setNotice(null);
		try {
			const saved = (await publishThemeFn({
				data: {
					scope: "tenant",
					scopeId: `draft-${Date.now()}`,
					seeds: {},
				},
			})) as ThemeSummary;
			// `as never`: the editor route is a splat — its search params are
			// typed by the editor page, not this one.
			await navigate({
				to: "/platform/theme/editor",
				search: { id: saved.id, fresh: "1" },
			} as never);
		} catch {
			setNotice(t.publishError);
		} finally {
			setBusy(null);
		}
	};

	const editTheme = (theme: ThemeSummary) =>
		void navigate({ to: "/platform/theme/editor", search: { id: theme.id } } as never);

	const toggle = async (id: number, enabled: boolean) => {
		setBusy(`toggle-${id}`);
		try {
			await setThemeEnabledFn({ data: { id, enabled } });
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	const preview = async (theme: ThemeSummary) => {
		setBusy(`preview-${theme.id}`);
		try {
			await setThemePreviewFn({ data: { themeId: theme.id } });
			window.location.reload();
		} finally {
			setBusy(null);
		}
	};

	const setMain = async (theme: ThemeSummary) => {
		setBusy(`main-${theme.id}`);
		setNotice(null);
		try {
			await setThemeMainFn({ data: { id: theme.id } });
			setNotice(t.mainSet);
			await router.invalidate();
		} catch {
			setNotice(t.publishError);
		} finally {
			setBusy(null);
		}
	};

	const confirmDelete = async () => {
		if (deleting === null) return;
		setBusy(`delete-${deleting.id}`);
		setNotice(null);
		try {
			await deleteThemeFn({ data: { id: deleting.id } });
			setDeleting(null);
			await router.invalidate();
		} catch {
			// Surface the failure (e.g. the main-row guard) instead of
			// silently closing — the dialog stays open for a retry.
			setNotice(t.deleteError);
			throw new Error(t.deleteError);
		} finally {
			setBusy(null);
		}
	};

	return (
		<PageContainer>
			<PageHeader
				title={t.pageTitle}
				description={t.pageDescription}
				actions={
					<Button size="sm" onClick={() => void createTheme()} disabled={busy !== null}>
						{busy === "create" ? (
							<Spinner className="size-4" />
						) : (
							<PlusIcon data-icon="inline-start" />
						)}
						{t.newTheme}
					</Button>
				}
			/>

			{notice !== null ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

			{themes.length === 0 ? (
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.emptyList}</EmptyTitle>
					</EmptyHeader>
					<EmptyContent>
						<Button size="sm" onClick={() => void createTheme()} disabled={busy !== null}>
							{busy === "create" ? (
								<Spinner className="size-4" />
							) : (
								<PlusIcon data-icon="inline-start" />
							)}
							{t.newTheme}
						</Button>
					</EmptyContent>
				</Empty>
			) : (
				<>
					<h2 className="text-sm font-medium">{t.listTitle}</h2>
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
							q.trim() === "" ? undefined : t.filteredCount(filtered.length, themes.length)
						}
					/>
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.colScope}</TableHead>
									<TableHead>{t.colScopeId}</TableHead>
									<TableHead>{t.colName}</TableHead>
									<TableHead>{t.colEnabled}</TableHead>
									<TableHead>{t.colVersion}</TableHead>
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
									filtered.map((theme) => (
										<TableRow key={theme.id}>
											<TableCell className="text-sm">{scopeLabel(theme.scope, t)}</TableCell>
											<TableCell className="font-mono text-xs text-muted-foreground">
												{theme.scopeId === "" ? "—" : theme.scopeId}
											</TableCell>
											<TableCell className="text-sm">
												<span className="inline-flex items-center gap-1.5">
													{brandNameOf(theme) ?? "—"}
													{theme.isMain ? <Badge variant="secondary">{t.badgeMain}</Badge> : null}
												</span>
											</TableCell>
											<TableCell>
												<Switch
													checked={theme.enabled}
													disabled={busy !== null}
													onCheckedChange={(checked) => void toggle(theme.id, checked === true)}
													aria-label={brandNameOf(theme) ?? `theme-${theme.id}`}
												/>
											</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{t.colVersion}
												{theme.version}
											</TableCell>
											<TableCell className="text-right">
												<div className="flex justify-end gap-1">
													<Button
														variant="ghost"
														size="sm"
														onClick={() => void preview(theme)}
														disabled={busy !== null}
													>
														{busy === `preview-${theme.id}` ? (
															<Spinner className="size-3.5" />
														) : null}
														{busy === `preview-${theme.id}` ? t.previewing : t.previewAction}
													</Button>
													{theme.isMain ? null : (
														<Button
															variant="ghost"
															size="sm"
															onClick={() => void setMain(theme)}
															disabled={busy !== null}
														>
															{busy === `main-${theme.id}` ? (
																<Spinner className="size-3.5" />
															) : (
																<StarIcon className="size-3.5" />
															)}
															{t.setMain}
														</Button>
													)}
													<Button
														variant="ghost"
														size="sm"
														onClick={() => editTheme(theme)}
														disabled={busy !== null}
													>
														<PencilIcon className="size-3.5" />
														{t.edit}
													</Button>
													{theme.isMain ? null : (
														<Button
															variant="ghost"
															size="sm"
															onClick={() => setDeleting(theme)}
															disabled={busy !== null}
														>
															<Trash2Icon className="size-3.5" />
															{t.deleteTheme}
														</Button>
													)}
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

			<ConfirmDialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
				title={t.deleteTheme}
				description={t.deleteConfirm}
				confirmLabel={t.deleteTheme}
				cancelLabel={t.cancel}
				variant="destructive"
				loading={deleting !== null && busy === `delete-${deleting.id}`}
				onConfirm={confirmDelete}
			/>

			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}
