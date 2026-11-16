import { useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ktbhealth/ui/components/collapsible";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
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
import type { PanelPageContext, Plugin } from "@ktb/kernel";

import { getThemeFn, publishThemeFn, setThemeEnabledFn, setThemePreviewFn } from "../fns.ts";
import { themeMessages } from "../i18n.ts";
import { contrastReport, deriveThemeTokens, type ContrastPair } from "../palette.ts";
import type {
	ResolvedTheme,
	ThemeAssetKind,
	ThemeFontConfig,
	ThemeFontSlot,
	ThemeScopeKind,
	ThemeSeeds,
	ThemeSummary,
} from "../types.ts";

export interface ThemePageData {
	readonly themes: readonly ThemeSummary[];
}

interface SeedFields {
	primary: string;
	secondary: string;
	accent: string;
	background: string;
	foreground: string;
	destructive: string;
	radius: string;
}

const EMPTY_SEEDS: SeedFields = {
	primary: "",
	secondary: "",
	accent: "",
	background: "",
	foreground: "",
	destructive: "",
	radius: "",
};

const seedsToFields = (seeds: ThemeSeeds | undefined): SeedFields => ({
	primary: seeds?.primary ?? "",
	secondary: seeds?.secondary ?? "",
	accent: seeds?.accent ?? "",
	background: seeds?.background ?? "",
	foreground: seeds?.foreground ?? "",
	destructive: seeds?.destructive ?? "",
	radius: seeds?.radius ?? "",
});

/** Blank fields mean "derive" — only non-empty values ship as seeds. */
const fieldsToSeeds = (f: SeedFields, dark: SeedFields): ThemeSeeds => {
	const pick = (s: string) => (s.trim() === "" ? undefined : s.trim());
	const darkSeeds = {
		primary: pick(dark.primary),
		secondary: pick(dark.secondary),
		accent: pick(dark.accent),
		background: pick(dark.background),
		foreground: pick(dark.foreground),
	};
	const hasDark = Object.values(darkSeeds).some((v) => v !== undefined);
	return {
		primary: pick(f.primary),
		secondary: pick(f.secondary),
		accent: pick(f.accent),
		background: pick(f.background),
		foreground: pick(f.foreground),
		destructive: pick(f.destructive),
		radius: pick(f.radius),
		...(hasDark ? { dark: darkSeeds } : {}),
	};
};

const ASSET_KIND_ITEMS = [
	"logo-light",
	"logo-dark",
	"wordmark",
	"favicon",
	"og-image",
	"font",
] as const satisfies readonly ThemeAssetKind[];

const FONT_SLOT_ITEMS = ["sans", "heading", "mono"] as const satisfies readonly ThemeFontSlot[];

function SeedInputs({
	fields,
	onChange,
	labels,
}: {
	fields: SeedFields;
	onChange: (next: SeedFields) => void;
	labels: readonly [string, string, string, string, string, string, string];
}) {
	const keys = [
		"primary",
		"secondary",
		"accent",
		"background",
		"foreground",
		"destructive",
		"radius",
	] as const;
	return (
		<div className="grid grid-cols-2 gap-3 md:grid-cols-4">
			{keys.map((key, i) => (
				<div key={key} className="space-y-1">
					<Label htmlFor={`seed-${key}`} className="text-xs">
						{labels[i]}
					</Label>
					<Input
						id={`seed-${key}`}
						value={fields[key]}
						onChange={(e) => onChange({ ...fields, [key]: e.target.value })}
						placeholder={key === "radius" ? "0.45rem" : "oklch(…) / #rrggbb"}
						className="font-mono text-xs"
					/>
				</div>
			))}
		</div>
	);
}

function ContrastTable({
	report,
	title,
	passLabel,
	failLabel,
}: {
	report: readonly ContrastPair[];
	title: string;
	passLabel: string;
	failLabel: string;
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-border">
			<header className="border-b border-border px-3 py-2">
				<h3 className="text-sm font-medium">{title}</h3>
			</header>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>Pairing</TableHead>
						<TableHead className="text-right">Ratio</TableHead>
						<TableHead className="text-right">Min</TableHead>
						<TableHead className="text-right">AA</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{report.map((p) => (
						<TableRow key={p.name}>
							<TableCell className="font-mono text-xs">{p.name}</TableCell>
							<TableCell className="text-right font-mono text-xs">{p.ratio}:1</TableCell>
							<TableCell className="text-right text-xs text-muted-foreground">{p.min}:1</TableCell>
							<TableCell className="text-right">
								<Badge variant={p.ok ? "default" : "destructive"}>
									{p.ok ? passLabel : failLabel}
								</Badge>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>
		</div>
	);
}

/** Palette strip: one chip per derived surface/brand color. */
function PaletteStrip({ tokens }: { tokens: ReturnType<typeof deriveThemeTokens> }) {
	const vars = [
		"--primary",
		"--secondary",
		"--accent",
		"--muted",
		"--background",
		"--card",
		"--border",
		"--ring",
		"--destructive",
	] as const;
	return (
		<div className="flex flex-wrap gap-2">
			{vars.map((v) => (
				<div key={v} className="flex items-center gap-1.5">
					<span
						className="inline-block size-5 rounded border border-border"
						style={{ background: tokens.light[v] }}
					/>
					<span className="font-mono text-[10px] text-muted-foreground">{v}</span>
				</div>
			))}
		</div>
	);
}

/**
 * `/platform/theme` admin page (P-082/PL-006 phase 5): scope picker,
 * seed editors with live palette preview + contrast report, font
 * delivery config, publish (upsert by scope), enable/disable and
 * cookie-based preview of any defined theme. Asset UPLOADS are Phase
 * 4 — the brand section manages name/URLs only (TODO markers below).
 */
export function ThemePage({ data, ctx }: { data: unknown; ctx: PanelPageContext }) {
	const t = themeMessages(ctx.locale);
	const router = useRouter();
	const themes = ((data as ThemePageData | null)?.themes ?? []) as readonly ThemeSummary[];

	const [scope, setScope] = useState<ThemeScopeKind>("platform");
	const [scopeId, setScopeId] = useState("");
	const [appName, setAppName] = useState("");
	const [seeds, setSeeds] = useState<SeedFields>(EMPTY_SEEDS);
	const [darkSeeds, setDarkSeeds] = useState<SeedFields>(EMPTY_SEEDS);
	const [delivery, setDelivery] = useState<"self-host" | "google-fonts">("self-host");
	const [fontSans, setFontSans] = useState("");
	const [fontHeading, setFontHeading] = useState("");
	const [fontMono, setFontMono] = useState("");
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);

	// Phase 4 asset uploads — target an EXISTING theme row (uploads link
	// to theme_assets.theme_id; publish first for a new scope).
	const [assetThemeId, setAssetThemeId] = useState<number | null>(themes[0]?.id ?? null);
	const [assetKind, setAssetKind] = useState<ThemeAssetKind>("logo-light");
	const [assetFile, setAssetFile] = useState<File | null>(null);
	const [assetFontFamily, setAssetFontFamily] = useState("");
	const [assetFontSlot, setAssetFontSlot] = useState<ThemeFontSlot>("sans");
	const [googleFamily, setGoogleFamily] = useState("");

	// Portal instances offered as scope-id suggestions (from the
	// registry handed to every panel page via ctx.plugins).
	const portalOptions = useMemo(
		() =>
			ctx.plugins.flatMap((p: Plugin) =>
				(p.portals ?? []).map((i) => ({ id: i.id, label: i.label })),
			),
		[ctx.plugins],
	);

	const currentSeeds = useMemo(() => fieldsToSeeds(seeds, darkSeeds), [seeds, darkSeeds]);
	const previewTokens = useMemo(() => deriveThemeTokens(currentSeeds), [currentSeeds]);
	const lightReport = useMemo(() => contrastReport(previewTokens, "light"), [previewTokens]);
	const darkReport = useMemo(() => contrastReport(previewTokens, "dark"), [previewTokens]);
	const allPass = [...lightReport, ...darkReport].every((p) => p.ok);

	const loadTheme = async (id: number) => {
		setBusy(`edit-${id}`);
		try {
			const theme = (await getThemeFn({ data: { id } })) as ResolvedTheme | null;
			if (theme === null) return;
			setScope(theme.scope);
			setScopeId(theme.scopeId);
			setAppName(theme.appName ?? theme.brand?.appName ?? "");
			setSeeds(seedsToFields(theme.seeds));
			setDarkSeeds(
				seedsToFields(
					theme.seeds.dark === undefined
						? undefined
						: {
								primary: theme.seeds.dark.primary,
								secondary: theme.seeds.dark.secondary,
								accent: theme.seeds.dark.accent,
								background: theme.seeds.dark.background,
								foreground: theme.seeds.dark.foreground,
							},
				),
			);
			setDelivery(theme.fonts?.delivery ?? "self-host");
			setFontSans(theme.fonts?.families?.sans ?? "");
			setFontHeading(theme.fonts?.families?.heading ?? "");
			setFontMono(theme.fonts?.families?.mono ?? "");
			setNotice(null);
		} finally {
			setBusy(null);
		}
	};

	const publish = async () => {
		setBusy("publish");
		setNotice(null);
		try {
			const families = {
				sans: fontSans.trim() === "" ? null : fontSans.trim(),
				heading: fontHeading.trim() === "" ? null : fontHeading.trim(),
				mono: fontMono.trim() === "" ? null : fontMono.trim(),
			};
			const hasFamilies = Object.values(families).some((v) => v !== null);
			const fonts: ThemeFontConfig | null = hasFamilies ? { delivery, families } : null;
			await publishThemeFn({
				data: {
					scope,
					scopeId: scope === "platform" ? "" : scopeId.trim(),
					appName: appName.trim() === "" ? null : appName.trim(),
					seeds: currentSeeds,
					fonts,
				},
			});
			setNotice(t.published);
			await router.invalidate();
		} catch {
			setNotice(t.publishError);
		} finally {
			setBusy(null);
		}
	};

	const toggle = async (id: number, enabled: boolean) => {
		setBusy(`toggle-${id}`);
		try {
			await setThemeEnabledFn({ data: { id, enabled } });
			await router.invalidate();
		} finally {
			setBusy(null);
		}
	};

	const preview = async (id: number | null) => {
		setBusy(
			/* v8 ignore next -- no UI path calls preview(null); the exit flow lives in ThemePreviewBanner */
			id === null ? "preview-off" : `preview-${id}`,
		);
		try {
			await setThemePreviewFn({ data: { themeId: id } });
			window.location.reload();
		} finally {
			setBusy(null);
		}
	};

	const uploadAsset = async () => {
		/* v8 ignore next -- the upload button is disabled in both states */
		if (assetThemeId === null || assetFile === null) return;
		setBusy("asset-upload");
		setNotice(null);
		try {
			const form = new FormData();
			form.set("file", assetFile);
			form.set("themeId", String(assetThemeId));
			form.set("kind", assetKind);
			if (assetKind === "font") {
				form.set("family", assetFontFamily.trim() || assetFile.name.replace(/\.[^.]+$/, ""));
				form.set("slot", assetFontSlot);
			}
			const res = await fetch("/api/theme/assets", { method: "POST", body: form });
			if (!res.ok) throw new Error(`upload failed: ${res.status}`);
			setAssetFile(null);
			setNotice(t.assetUploaded);
		} catch {
			setNotice(t.assetUploadError);
		} finally {
			setBusy(null);
		}
	};

	const fetchGoogleFont = async () => {
		/* v8 ignore next -- the fetch button is disabled in both states */
		if (assetThemeId === null || googleFamily.trim() === "") return;
		setBusy("asset-google");
		setNotice(null);
		try {
			const res = await fetch("/api/theme/fonts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					themeId: assetThemeId,
					family: googleFamily.trim(),
					slot: assetFontSlot,
				}),
			});
			if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
			setNotice(t.assetUploaded);
		} catch {
			setNotice(t.assetGoogleError);
		} finally {
			setBusy(null);
		}
	};

	const scopeLabel = (s: ThemeSummary) =>
		s.scope === "platform"
			? t.scopePlatform
			: s.scope === "tenant"
				? `${t.scopeTenant}${s.scopeId === "" ? "" : ` #${s.scopeId}`}`
				: `${t.scopePortalInstance}${s.scopeId === "" ? "" : ` · ${s.scopeId}`}`;

	return (
		<PageContainer>
			<PageHeader title={t.pageTitle} description={t.pageDescription} />

			<section className="space-y-4 rounded-lg border border-border p-4">
				<h2 className="text-sm font-medium">{t.seedsTitle}</h2>
				<p className="text-xs text-muted-foreground">{t.seedsDescription}</p>

				<div className="grid gap-3 md:grid-cols-3">
					<div className="space-y-1">
						<Label className="text-xs">{t.scopeLabel}</Label>
						<Select
							items={[
								{ value: "platform", label: t.scopePlatform },
								{ value: "tenant", label: t.scopeTenant },
								{ value: "portal-instance", label: t.scopePortalInstance },
							]}
							value={scope}
							onValueChange={(v) => setScope(v as ThemeScopeKind)}
						>
							<SelectTrigger aria-label={t.scopeLabel} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="platform">{t.scopePlatform}</SelectItem>
								<SelectItem value="tenant">{t.scopeTenant}</SelectItem>
								<SelectItem value="portal-instance">{t.scopePortalInstance}</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{scope !== "platform" ? (
						<div className="space-y-1 md:col-span-2">
							<Label htmlFor="theme-scope-id" className="text-xs">
								{t.scopeIdLabel}
							</Label>
							<Input
								id="theme-scope-id"
								value={scopeId}
								onChange={(e) => setScopeId(e.target.value)}
								placeholder={t.scopeIdPlaceholder}
								list={scope === "portal-instance" ? "theme-portal-ids" : undefined}
							/>
							{scope === "portal-instance" ? (
								<datalist id="theme-portal-ids">
									{portalOptions.map((p) => (
										<option key={p.id} value={p.id}>
											{p.label}
										</option>
									))}
								</datalist>
							) : null}
						</div>
					) : null}
					<div className="space-y-1">
						<Label htmlFor="theme-app-name" className="text-xs">
							{t.appNameLabel}
						</Label>
						<Input
							id="theme-app-name"
							value={appName}
							onChange={(e) => setAppName(e.target.value)}
							placeholder={t.appNamePlaceholder}
						/>
					</div>
				</div>

				<SeedInputs
					fields={seeds}
					onChange={setSeeds}
					labels={[
						t.seedPrimary,
						t.seedSecondary,
						t.seedAccent,
						t.seedBackground,
						t.seedForeground,
						t.seedDestructive,
						t.seedRadius,
					]}
				/>

				<Collapsible className="rounded-md border border-border p-3">
					<CollapsibleTrigger className="cursor-pointer text-sm font-medium">
						{t.darkTitle}
					</CollapsibleTrigger>
					{/* keepMounted mirrors <details>: the controlled inputs stay
					    in the DOM (hidden) so ids/queries remain stable. */}
					<CollapsibleContent keepMounted>
						<p className="mt-1 text-xs text-muted-foreground">{t.darkDescription}</p>
						<div className="mt-3">
							<SeedInputs
								fields={darkSeeds}
								onChange={setDarkSeeds}
								labels={[
									t.seedPrimary,
									t.seedSecondary,
									t.seedAccent,
									t.seedBackground,
									t.seedForeground,
									"—",
									"—",
								]}
							/>
						</div>
					</CollapsibleContent>
				</Collapsible>

				<div className="space-y-3 rounded-md border border-border p-3">
					<h3 className="text-sm font-medium">{t.fontsTitle}</h3>
					<div className="grid gap-3 md:grid-cols-2">
						<div className="space-y-1">
							<Label className="text-xs">{t.fontsDeliveryLabel}</Label>
							<Select
								items={[
									{ value: "self-host", label: t.fontsSelfHost },
									{ value: "google-fonts", label: t.fontsGoogle },
								]}
								value={delivery}
								onValueChange={(v) => setDelivery(v as "self-host" | "google-fonts")}
							>
								<SelectTrigger aria-label={t.fontsDeliveryLabel} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="self-host">{t.fontsSelfHost}</SelectItem>
									<SelectItem value="google-fonts">{t.fontsGoogle}</SelectItem>
								</SelectContent>
							</Select>
							{delivery === "google-fonts" ? (
								<p className="text-xs text-amber-600">{t.fontsGoogleWarning}</p>
							) : null}
						</div>
						<div className="grid grid-cols-3 gap-2">
							{(
								[
									[fontSans, setFontSans, t.fontSans, "font-sans"],
									[fontHeading, setFontHeading, t.fontHeading, "font-heading"],
									[fontMono, setFontMono, t.fontMono, "font-mono"],
								] as const
							).map(([value, set, label, id]) => (
								<div key={id} className="space-y-1">
									<Label htmlFor={`theme-${id}`} className="text-xs">
										{label}
									</Label>
									<Input
										id={`theme-${id}`}
										value={value}
										onChange={(e) => set(e.target.value)}
										placeholder="Inter"
										className="text-xs"
									/>
								</div>
							))}
						</div>
					</div>
					<p className="text-xs text-muted-foreground">{t.fontsFamiliesLabel}</p>
				</div>

				<div className="space-y-3 rounded-md border border-border p-3">
					<h3 className="text-sm font-medium">{t.brandTitle}</h3>
					<div className="space-y-1">
						<Label htmlFor="theme-brand-name" className="text-xs">
							{t.brandAppName}
						</Label>
						<Input
							id="theme-brand-name"
							value={appName}
							onChange={(e) => setAppName(e.target.value)}
							placeholder={t.appNamePlaceholder}
						/>
					</div>
					<p className="text-xs text-muted-foreground">{t.assetTodo}</p>
				</div>

				<section className="space-y-3 rounded-lg border border-border p-4">
					<h2 className="text-sm font-medium">{t.assetsTitle}</h2>
					<div className="grid gap-3 md:grid-cols-4">
						<div className="space-y-1">
							<Label className="text-xs">{t.assetThemeLabel}</Label>
							<Select
								items={themes.map((theme) => ({
									value: String(theme.id),
									label: theme.appName ?? `${theme.scope}#${theme.id}`,
								}))}
								value={assetThemeId === null ? null : String(assetThemeId)}
								onValueChange={(v) =>
									setAssetThemeId(
										// Item values are always numeric theme ids — the
										// NaN fallback is unreachable.
										/* v8 ignore next */ Number(v) || null,
									)
								}
								disabled={themes.length === 0}
							>
								<SelectTrigger aria-label={t.assetThemeLabel} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{themes.map((theme) => (
										<SelectItem key={theme.id} value={String(theme.id)}>
											{theme.appName ?? `${theme.scope}#${theme.id}`}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1">
							<Label className="text-xs">{t.assetKindLabel}</Label>
							<Select
								items={ASSET_KIND_ITEMS.map((k) => ({ value: k, label: k }))}
								value={assetKind}
								onValueChange={(v) => setAssetKind(v as ThemeAssetKind)}
							>
								<SelectTrigger aria-label={t.assetKindLabel} className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{ASSET_KIND_ITEMS.map((k) => (
										<SelectItem key={k} value={k}>
											{k}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						{assetKind === "font" ? (
							<>
								<div className="space-y-1">
									<Label htmlFor="asset-font-family" className="text-xs">
										{t.assetFontFamily}
									</Label>
									<Input
										id="asset-font-family"
										value={assetFontFamily}
										onChange={(e) => setAssetFontFamily(e.target.value)}
										placeholder="Inter"
									/>
								</div>
								<div className="space-y-1">
									<Label className="text-xs">{t.assetFontSlot}</Label>
									<Select
										items={FONT_SLOT_ITEMS.map((s) => ({ value: s, label: s }))}
										value={assetFontSlot}
										onValueChange={(v) => setAssetFontSlot(v as ThemeFontSlot)}
									>
										<SelectTrigger aria-label={t.assetFontSlot} className="w-full">
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{FONT_SLOT_ITEMS.map((s) => (
												<SelectItem key={s} value={s}>
													{s}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</>
						) : null}
						<div className="space-y-1">
							<Label htmlFor="asset-file" className="text-xs">
								{t.assetFileLabel}
							</Label>
							<Input
								id="asset-file"
								type="file"
								onChange={(e) => setAssetFile(e.target.files?.[0] ?? null)}
							/>
						</div>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Button
							onClick={() => void uploadAsset()}
							disabled={busy !== null || assetThemeId === null || assetFile === null}
						>
							{busy === "asset-upload" ? <Spinner className="size-4" /> : null}
							{busy === "asset-upload" ? t.assetUploading : t.assetUpload}
						</Button>
						<span className="text-xs text-muted-foreground">{t.assetTodo}</span>
					</div>
					<div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
						<Input
							value={googleFamily}
							onChange={(e) => setGoogleFamily(e.target.value)}
							placeholder="Inter"
							className="w-48 text-xs"
							aria-label={t.assetFontFamily}
						/>
						<Button
							variant="outline"
							onClick={() => void fetchGoogleFont()}
							disabled={busy !== null || assetThemeId === null || googleFamily.trim() === ""}
						>
							{busy === "asset-google" ? <Spinner className="size-4" /> : null}
							{busy === "asset-google" ? t.assetGoogleFetching : t.assetGoogleFetch}
						</Button>
					</div>
				</section>

				<div className="space-y-3">
					<h3 className="text-sm font-medium">{t.previewTitle}</h3>
					<p className="text-xs text-muted-foreground">{t.previewDescription}</p>
					<PaletteStrip tokens={previewTokens} />
					<div className="grid gap-3 lg:grid-cols-2">
						<ContrastTable
							report={lightReport}
							title={t.contrastLight}
							passLabel={t.contrastPass}
							failLabel={t.contrastFail}
						/>
						<ContrastTable
							report={darkReport}
							title={t.contrastDark}
							passLabel={t.contrastPass}
							failLabel={t.contrastFail}
						/>
					</div>
					<Badge variant={allPass ? "default" : "secondary"}>
						{allPass ? t.contrastPass : t.contrastFail}
					</Badge>
				</div>

				<div className="flex items-center gap-3">
					<Button onClick={() => void publish()} disabled={busy !== null}>
						{busy === "publish" ? <Spinner className="size-4" /> : null}
						{busy === "publish" ? t.publishing : t.publish}
					</Button>
					{notice !== null ? <span className="text-sm text-muted-foreground">{notice}</span> : null}
				</div>
			</section>

			<section className="overflow-hidden rounded-lg border border-border">
				<header className="border-b border-border px-3 py-2">
					<h2 className="text-sm font-medium">{t.listTitle}</h2>
				</header>
				{themes.length === 0 ? (
					<p className="px-3 py-6 text-center text-sm text-muted-foreground">{t.emptyList}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.colScope}</TableHead>
								<TableHead>{t.colScopeId}</TableHead>
								<TableHead>{t.colName}</TableHead>
								<TableHead>{t.colEnabled}</TableHead>
								<TableHead className="text-right">{t.colActions}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{themes.map((theme) => (
								<TableRow key={theme.id}>
									<TableCell className="text-sm">{scopeLabel(theme)}</TableCell>
									<TableCell className="font-mono text-xs text-muted-foreground">
										{theme.scopeId === "" ? "—" : theme.scopeId}
									</TableCell>
									<TableCell className="text-sm">
										{theme.appName ?? "—"}
										<span className="ml-1 text-xs text-muted-foreground">
											{t.colVersion}
											{theme.version}
										</span>
									</TableCell>
									<TableCell>
										<Switch
											checked={theme.enabled}
											disabled={busy !== null}
											onCheckedChange={(checked) => void toggle(theme.id, checked)}
											aria-label={theme.appName ?? `theme-${theme.id}`}
										/>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex justify-end gap-1">
											<Button
												variant="ghost"
												size="sm"
												onClick={() => void loadTheme(theme.id)}
												disabled={busy !== null}
											>
												{busy === `edit-${theme.id}` ? <Spinner className="size-3.5" /> : null}
												{t.edit}
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => void preview(theme.id)}
												disabled={busy !== null}
											>
												{busy === `preview-${theme.id}` ? <Spinner className="size-3.5" /> : null}
												{t.previewAction}
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>
		</PageContainer>
	);
}
