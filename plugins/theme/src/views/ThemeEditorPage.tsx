import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { ArrowLeftIcon } from "lucide-react";

import { Toast, type ToastData } from "@ktbhealth/ui/components/app-toast";
import { Alert, AlertDescription, AlertTitle } from "@ktbhealth/ui/components/alert";
import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyTitle,
} from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { Progress } from "@ktbhealth/ui/components/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Separator } from "@ktbhealth/ui/components/separator";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";
import { Textarea } from "@ktbhealth/ui/components/textarea";
import type { PanelPageContext } from "@ktb/kernel";

import {
	deleteThemeFn,
	getThemeFn,
	listThemeAssetsFn,
	publishThemeFn,
	setThemePreviewFn,
} from "../fns.ts";
import { themeMessages, type ThemeMessages } from "../i18n.ts";
import { contrastReport, deriveThemeTokens, themeRadius, type ContrastPair } from "../palette.ts";
import { fontCssVars } from "../present.ts";
import type {
	ResolvedTheme,
	ThemeAssetKind,
	ThemeAssetSummary,
	ThemeFontConfig,
	ThemeFontSlot,
	ThemeScopeKind,
	ThemeSeeds,
	ThemeSummary,
} from "../types.ts";

export interface ThemeEditorPageData {
	readonly themes: readonly ThemeSummary[];
}

type EditorTab = "tokens" | "components" | "blocks";
type Scheme = "light" | "dark";

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

const IMAGE_KIND_ITEMS = [
	"logo-light",
	"logo-dark",
	"wordmark",
	"favicon",
	"og-image",
] as const satisfies readonly Exclude<ThemeAssetKind, "font">[];

const FONT_SLOT_ITEMS = ["sans", "heading", "mono"] as const satisfies readonly ThemeFontSlot[];

const SCOPE_ITEMS = [
	"platform",
	"tenant",
	"portal-instance",
] as const satisfies readonly ThemeScopeKind[];

const SEED_LABEL_KEYS = [
	"seedPrimary",
	"seedSecondary",
	"seedAccent",
	"seedBackground",
	"seedForeground",
	"seedDestructive",
	"seedRadius",
] as const;

const ASSET_KIND_LABEL_KEYS = {
	"logo-light": "assetKindLogoLight",
	"logo-dark": "assetKindLogoDark",
	wordmark: "assetKindWordmark",
	favicon: "assetKindFavicon",
	"og-image": "assetKindOgImage",
	font: "assetKindFont",
} as const satisfies Record<ThemeAssetKind, keyof ThemeMessages>;

function SeedInputs({
	fields,
	onChange,
	labels,
	idPrefix,
}: {
	fields: SeedFields;
	onChange: (next: SeedFields) => void;
	labels: readonly [string, string, string, string, string, string, string];
	idPrefix: string;
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
		<div className="space-y-2">
			{keys.map((key, i) => (
				<div key={key} className="flex items-center gap-3">
					<Label htmlFor={`${idPrefix}-${key}`} className="w-24 shrink-0 text-xs">
						{labels[i]}
					</Label>
					<Input
						id={`${idPrefix}-${key}`}
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
		"--success",
		"--warning",
		"--info",
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

/** `variants` is free-form JSON — pull the two fields the UI surfaces. */
const variantInfo = (variants: unknown): { dominantColor?: string; error?: string } => {
	if (typeof variants !== "object" || variants === null) return {};
	const v = variants as Record<string, unknown>;
	return {
		dominantColor: typeof v.dominantColor === "string" ? v.dominantColor : undefined,
		error: typeof v.error === "string" ? v.error : undefined,
	};
};

const assetStatusVariant = (status: string): "default" | "secondary" | "destructive" =>
	status === "ready" ? "default" : status === "failed" ? "destructive" : "secondary";

function EditorSection({
	id,
	title,
	description,
	children,
	sectionRef,
}: {
	id: string;
	title: string;
	description?: string;
	children: ReactNode;
	sectionRef?: (el: HTMLElement | null) => void;
}) {
	return (
		<section id={id} ref={sectionRef} className="scroll-mt-6 space-y-4">
			<div className="space-y-1">
				<h2 className="text-base font-semibold">{title}</h2>
				{description !== undefined && description !== "" ? (
					<p className="text-sm text-muted-foreground">{description}</p>
				) : null}
			</div>
			{children}
		</section>
	);
}

/**
 * `/platform/theme/editor?id=<n>[&fresh=1]` — dedicated theme editor.
 * Left sidebar navigates the three main tabs (Tokens / Components /
 * Blocks) plus in-page anchors for the token sections; the main pane
 * renders the draft theme's derived tokens live around design-system
 * components as a gallery.
 *
 * `fresh=1` marks an auto-created draft from the list page: hitting
 * Back without any edit deletes the row (deleteThemeFn) and flags
 * sessionStorage so the list can toast "empty theme discarded".
 * Uploads POST multipart to `/api/theme/assets` and JSON to
 * `/api/theme/fonts` — both keyed by the persisted theme id.
 */
export function ThemeEditorPage({ ctx }: { ctx: PanelPageContext }) {
	const t = themeMessages(ctx.locale);
	const router = useRouter();
	const navigate = useNavigate();
	const search = useSearch({ strict: false }) as { id?: string | number; fresh?: string };
	const id = Number(search.id);
	const fresh = String(search.fresh ?? "") === "1";

	const [theme, setTheme] = useState<ResolvedTheme | null>(null);
	const [loadState, setLoadState] = useState<"loading" | "ready" | "missing">(() =>
		Number.isInteger(id) && id > 0 ? "loading" : "missing",
	);
	const [seeds, setSeeds] = useState<SeedFields>(EMPTY_SEEDS);
	const [darkSeeds, setDarkSeeds] = useState<SeedFields>(EMPTY_SEEDS);
	const [fonts, setFonts] = useState<ThemeFontConfig | null>(null);
	const [scope, setScope] = useState<ThemeScopeKind>("tenant");
	const [scopeId, setScopeId] = useState("");
	const [appName, setAppName] = useState("");
	const [assets, setAssets] = useState<readonly ThemeAssetSummary[]>([]);
	const [tab, setTab] = useState<EditorTab>("tokens");
	const [scheme, setScheme] = useState<Scheme>("light");
	const [touched, setTouched] = useState(false);
	const [saving, setSaving] = useState(false);
	const [busy, setBusy] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [toast, setToast] = useState<ToastData | null>(null);

	const mark = () => setTouched(true);

	const seedLabels = useMemo(
		() =>
			SEED_LABEL_KEYS.map((k) => t[k]) as [string, string, string, string, string, string, string],
		[t],
	);

	useEffect(() => {
		if (!Number.isInteger(id) || id <= 0) return;
		let cancelled = false;
		setLoadState("loading");
		void (async () => {
			try {
				const [th, assetRows] = await Promise.all([
					getThemeFn({ data: { id } }) as Promise<ResolvedTheme | null>,
					listThemeAssetsFn({ data: { themeId: id } }) as Promise<readonly ThemeAssetSummary[]>,
				]);
				if (cancelled) return;
				if (th === null) {
					setLoadState("missing");
					return;
				}
				setTheme(th);
				setSeeds(seedsToFields(th.seeds));
				setDarkSeeds(seedsToFields(th.seeds.dark));
				setFonts(th.fonts);
				setScope(th.scope);
				setScopeId(th.scopeId);
				setAppName(th.appName ?? th.brand?.appName ?? "");
				setAssets(assetRows);
				setLoadState("ready");
			} catch {
				if (!cancelled) setLoadState("missing");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [id]);

	const currentSeeds = useMemo(() => fieldsToSeeds(seeds, darkSeeds), [seeds, darkSeeds]);
	const previewTokens = useMemo(() => deriveThemeTokens(currentSeeds), [currentSeeds]);
	const lightReport = useMemo(() => contrastReport(previewTokens, "light"), [previewTokens]);
	const darkReport = useMemo(() => contrastReport(previewTokens, "dark"), [previewTokens]);
	const fontVars = useMemo(() => fontCssVars(fonts), [fonts]);
	const schemeStyle = useMemo<CSSProperties>(
		() =>
			({
				...(scheme === "light" ? previewTokens.light : previewTokens.dark),
				...fontVars,
			}) as CSSProperties,
		[scheme, previewTokens, fontVars],
	);

	const brand = theme?.brand ?? null;
	const brandRefs =
		brand === null
			? []
			: (
					[
						["appName", t.brandAppName],
						["logoLight", t.assetKindLogoLight],
						["logoDark", t.assetKindLogoDark],
						["wordmark", t.assetKindWordmark],
						["favicon", t.assetKindFavicon],
						["ogImage", t.assetKindOgImage],
					] as const
				).flatMap(([key, label]) => {
					const value = key === "appName" ? appName || null : brand[key];
					return value === null || value === undefined || value === "" ? [] : [{ label, value }];
				});

	const scopeLabel = (s: ThemeScopeKind): string =>
		s === "platform" ? t.scopePlatform : s === "tenant" ? t.scopeTenant : t.scopePortalInstance;

	const goBack = async () => {
		// Untouched auto-created draft → delete the empty row and let the
		// list page toast about it. Touched or pre-existing themes stay.
		if (fresh && !touched && theme !== null) {
			try {
				await deleteThemeFn({ data: { id: theme.id } });
				sessionStorage.setItem("ktb-theme-discarded", "1");
			} catch {
				// Deletion failed — still leave; the row is harmless.
			}
		}
		await router.invalidate();
		void navigate({ to: "/platform/theme" } as never);
	};

	const publish = async () => {
		if (theme === null || saving) return;
		setSaving(true);
		setNotice(null);
		try {
			const saved = (await publishThemeFn({
				data: {
					id: theme.id,
					scope,
					scopeId: scope === "platform" ? "" : scopeId.trim(),
					appName: appName.trim() === "" ? null : appName.trim(),
					seeds: currentSeeds,
					fonts,
				},
			})) as ThemeSummary;
			setTheme((prev) =>
				prev === null
					? prev
					: {
							...prev,
							...saved,
							seeds: prev.seeds,
							fonts: fonts ?? prev.fonts,
							brand: prev.brand,
							preview: prev.preview,
						},
			);
			setTouched(true);
			setNotice(t.published);
			await router.invalidate();
		} catch {
			setNotice(t.publishError);
		} finally {
			setSaving(false);
		}
	};

	const preview = async () => {
		if (theme === null || busy !== null) return;
		setBusy("preview");
		try {
			const next = !theme.preview;
			const res = (await setThemePreviewFn({
				data: { themeId: next ? theme.id : null },
			})) as { ok: boolean };
			if (!res.ok) throw new Error("preview failed");
			setTheme({ ...theme, preview: next || undefined });
			window.location.reload();
		} catch {
			setNotice(t.publishError);
			setBusy(null);
		}
	};

	const refreshAssets = async () => {
		try {
			const rows = (await listThemeAssetsFn({
				data: { themeId: id },
			})) as readonly ThemeAssetSummary[];
			setAssets(rows);
			// Uploads mutate fonts/brand server-side — reload the theme too.
			const th = (await getThemeFn({ data: { id } })) as ResolvedTheme | null;
			if (th !== null) {
				setTheme(th);
				setFonts(th.fonts);
				setAppName(th.appName ?? th.brand?.appName ?? "");
			}
		} catch {
			setNotice(t.assetUploadError);
		}
	};

	const uploadAsset = async (
		kind: ThemeAssetKind,
		file: File,
		family?: string,
		slot?: ThemeFontSlot,
	): Promise<boolean> => {
		if (theme === null) return false;
		setBusy(`upload-${kind}`);
		setNotice(null);
		try {
			const form = new FormData();
			form.set("file", file);
			form.set("themeId", String(theme.id));
			form.set("kind", kind);
			if (kind === "font") {
				form.set("family", (family ?? "").trim() || file.name.replace(/\.[^.]+$/, ""));
				form.set("slot", slot ?? "sans");
			}
			const res = await fetch("/api/theme/assets", { method: "POST", body: form });
			if (!res.ok) throw new Error(`upload failed: ${res.status}`);
			setNotice(t.assetUploaded);
			await refreshAssets();
			return true;
		} catch {
			setNotice(t.assetUploadError);
			return false;
		} finally {
			setBusy(null);
		}
	};

	const [googleFamily, setGoogleFamily] = useState("");
	const [googleSlot, setGoogleSlot] = useState<ThemeFontSlot>("sans");
	const [fontFamily, setFontFamily] = useState("");
	const [fontSlot, setFontSlot] = useState<ThemeFontSlot>("sans");
	const [assetFiles, setAssetFiles] = useState<Partial<Record<ThemeAssetKind, File | null>>>({});
	const [fontFile, setFontFile] = useState<File | null>(null);

	const fetchGoogleFont = async () => {
		if (theme === null || googleFamily.trim() === "") return;
		setBusy("google-fetch");
		setNotice(null);
		try {
			const res = await fetch("/api/theme/fonts", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					themeId: theme.id,
					family: googleFamily.trim(),
					slot: googleSlot,
				}),
			});
			if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
			setNotice(t.assetUploaded);
			await refreshAssets();
		} catch {
			setNotice(t.assetGoogleError);
		} finally {
			setBusy(null);
		}
	};

	const setFontDelivery = (delivery: "self-host" | "google-fonts") => {
		mark();
		setFonts((f) => ({ ...(f ?? {}), delivery }));
	};
	const setFontFamilySlot = (slot: ThemeFontSlot, family: string) => {
		mark();
		setFonts((f) => ({
			...(f ?? {}),
			delivery: f?.delivery ?? "self-host",
			families: { ...(f?.families ?? {}), [slot]: family === "" ? null : family },
		}));
	};
	const setFontWeights = (raw: string) => {
		mark();
		const weights = raw
			.split(/[,\s]+/)
			.map((w) => Number.parseInt(w, 10))
			.filter((w) => Number.isInteger(w) && w >= 100 && w <= 900);
		setFonts((f) => ({
			...(f ?? {}),
			delivery: f?.delivery ?? "self-host",
			weights: weights.length === 0 ? undefined : weights,
		}));
	};

	const renderSettings = () => (
		<div className="space-y-6">
			<EditorSection id="section-general" title={t.tabGeneral}>
				<Card>
					<CardContent className="space-y-4 pt-6">
						<div className="space-y-1.5">
							<Label htmlFor="ed-scope">{t.scopeLabel}</Label>
							<Select
								value={scope}
								onValueChange={(v) => {
									mark();
									setScope(v as ThemeScopeKind);
								}}
							>
								<SelectTrigger id="ed-scope" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{SCOPE_ITEMS.map((s) => (
										<SelectItem key={s} value={s}>
											{scopeLabel(s)}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ed-scope-id">{t.scopeIdLabel}</Label>
							<Input
								id="ed-scope-id"
								value={scopeId}
								disabled={scope === "platform"}
								onChange={(e) => {
									mark();
									setScopeId(e.target.value);
								}}
								placeholder={t.scopeIdPlaceholder}
							/>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="ed-app-name">{t.appNameLabel}</Label>
							<Input
								id="ed-app-name"
								value={appName}
								onChange={(e) => {
									mark();
									setAppName(e.target.value);
								}}
								placeholder={t.appNamePlaceholder}
							/>
						</div>
					</CardContent>
				</Card>
			</EditorSection>

			<EditorSection id="section-colors" title={t.tabColors} description={t.seedsDescription}>
				<div className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.seedsTitle}</CardTitle>
						</CardHeader>
						<CardContent>
							<SeedInputs
								idPrefix="seed-light"
								fields={seeds}
								labels={seedLabels}
								onChange={(next) => {
									mark();
									setSeeds(next);
								}}
							/>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.darkTitle}</CardTitle>
							<CardDescription className="text-xs">{t.darkDescription}</CardDescription>
						</CardHeader>
						<CardContent>
							<SeedInputs
								idPrefix="seed-dark"
								fields={darkSeeds}
								labels={seedLabels}
								onChange={(next) => {
									mark();
									setDarkSeeds(next);
								}}
							/>
						</CardContent>
					</Card>
				</div>
			</EditorSection>

			<EditorSection id="section-typography" title={t.fontsTitle}>
				<Card>
					<CardContent className="space-y-4 pt-6">
						<div className="space-y-1.5">
							<Label>{t.fontsDeliveryLabel}</Label>
							<Select
								value={fonts?.delivery ?? "self-host"}
								onValueChange={(v) => setFontDelivery(v as "self-host" | "google-fonts")}
							>
								<SelectTrigger className="w-full sm:w-72">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="self-host">{t.fontsSelfHost}</SelectItem>
									<SelectItem value="google-fonts">{t.fontsGoogle}</SelectItem>
								</SelectContent>
							</Select>
							{fonts?.delivery === "google-fonts" ? (
								<Alert>
									<AlertTitle className="text-xs">{t.fontsGoogleWarning}</AlertTitle>
								</Alert>
							) : null}
						</div>
						<div className="space-y-1.5">
							<Label>{t.fontsFamiliesLabel}</Label>
							<div className="space-y-2">
								{FONT_SLOT_ITEMS.map((slot) => (
									<div key={slot} className="flex items-center gap-3">
										<Label htmlFor={`font-${slot}`} className="w-24 shrink-0 text-xs">
											{slot === "sans"
												? t.fontSans
												: slot === "heading"
													? t.fontHeading
													: t.fontMono}
										</Label>
										<Input
											id={`font-${slot}`}
											value={fonts?.families?.[slot] ?? ""}
											onChange={(e) => setFontFamilySlot(slot, e.target.value)}
											placeholder="Inter, system-ui, sans-serif"
											className="font-mono text-xs"
										/>
									</div>
								))}
							</div>
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="font-weights" className="text-xs">
								Weights (comma-separated)
							</Label>
							<Input
								id="font-weights"
								defaultValue={(fonts?.weights ?? []).join(", ")}
								onChange={(e) => setFontWeights(e.target.value)}
								placeholder="400, 500, 600, 700"
								className="w-48 font-mono text-xs"
							/>
						</div>
					</CardContent>
				</Card>
			</EditorSection>

			<EditorSection id="section-assets" title={t.assetsTitle} description={t.assetsNeedSave}>
				<div className="space-y-4">
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.tabAssets}</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							{IMAGE_KIND_ITEMS.map((kind) => {
								const file = assetFiles[kind] ?? null;
								const current =
									kind === "logo-light"
										? brand?.logoLight
										: kind === "logo-dark"
											? brand?.logoDark
											: kind === "wordmark"
												? brand?.wordmark
												: kind === "favicon"
													? brand?.favicon
													: brand?.ogImage;
								return (
									<div key={kind} className="space-y-1.5">
										<Label className="text-xs">{t[ASSET_KIND_LABEL_KEYS[kind]]}</Label>
										<div className="flex items-center gap-2">
											<Input
												type="file"
												accept="image/*"
												className="h-8 text-xs"
												onChange={(e) => {
													setAssetFiles((prev) => ({
														...prev,
														[kind]: e.target.files?.[0] ?? null,
													}));
												}}
											/>
											<Button
												variant="outline"
												size="sm"
												disabled={file === null || busy !== null}
												onClick={() => {
													if (file !== null) {
														void uploadAsset(kind, file).then((ok) => {
															if (ok) {
																setAssetFiles((prev) => ({ ...prev, [kind]: null }));
															}
														});
													}
												}}
											>
												{busy === `upload-${kind}` ? <Spinner className="size-3.5" /> : null}
												{t.assetUpload}
											</Button>
										</div>
										{current !== null && current !== undefined && current !== "" ? (
											<p className="truncate font-mono text-[10px] text-muted-foreground">
												{current}
											</p>
										) : null}
									</div>
								);
							})}
							<Separator />
							<div className="space-y-1.5">
								<Label className="text-xs">{t.assetFontUpload}</Label>
								<div className="space-y-2">
									<Input
										value={fontFamily}
										onChange={(e) => setFontFamily(e.target.value)}
										placeholder={t.assetFontFamily}
										className="h-8 text-xs"
									/>
									<Select value={fontSlot} onValueChange={(v) => setFontSlot(v as ThemeFontSlot)}>
										<SelectTrigger className="h-8 text-xs">
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
									<div className="flex items-center gap-2">
										<Input
											type="file"
											accept=".woff2,.woff,.ttf,.otf"
											className="h-8 text-xs"
											onChange={(e) => setFontFile(e.target.files?.[0] ?? null)}
										/>
										<Button
											variant="outline"
											size="sm"
											disabled={fontFile === null || busy !== null}
											onClick={() => {
												if (fontFile !== null) {
													void uploadAsset("font", fontFile, fontFamily, fontSlot).then((ok) => {
														if (ok) setFontFile(null);
													});
												}
											}}
										>
											{busy === "upload-font" ? <Spinner className="size-3.5" /> : null}
											{t.assetFontUpload}
										</Button>
									</div>
								</div>
							</div>
							<Separator />
							<div className="space-y-1.5">
								<Label className="text-xs">{t.assetGoogleFetch}</Label>
								<div className="space-y-2">
									<Input
										value={googleFamily}
										onChange={(e) => setGoogleFamily(e.target.value)}
										placeholder={t.assetGoogleFamily}
										className="h-8 text-xs"
									/>
									<Select
										value={googleSlot}
										onValueChange={(v) => setGoogleSlot(v as ThemeFontSlot)}
									>
										<SelectTrigger className="h-8 text-xs">
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
									<Button
										variant="outline"
										size="sm"
										disabled={googleFamily.trim() === "" || busy !== null}
										onClick={() => void fetchGoogleFont()}
									>
										{busy === "google-fetch" ? <Spinner className="size-3.5" /> : null}
										{t.assetGoogleFetch}
									</Button>
								</div>
							</div>
						</CardContent>
					</Card>
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.assetsListTitle}</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							{brandRefs.length > 0 ? (
								<section className="space-y-1">
									<h3 className="text-xs font-medium text-muted-foreground">{t.brandRefsTitle}</h3>
									<dl className="space-y-1">
										{brandRefs.map((ref) => (
											<div key={ref.label} className="flex gap-2 text-xs">
												<dt className="w-28 shrink-0 text-muted-foreground">{ref.label}</dt>
												<dd className="truncate font-mono">{ref.value}</dd>
											</div>
										))}
									</dl>
								</section>
							) : null}
							{assets.length === 0 ? (
								<p className="text-sm text-muted-foreground">{t.assetsEmpty}</p>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t.assetKindLabel}</TableHead>
											<TableHead>Status</TableHead>
											<TableHead className="text-right">Color</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{assets.map((a) => {
											const info = variantInfo(a.variants);
											return (
												<TableRow key={a.id}>
													<TableCell className="text-xs">
														{t[ASSET_KIND_LABEL_KEYS[a.kind]]}
													</TableCell>
													<TableCell>
														<Badge variant={assetStatusVariant(a.status)}>
															{a.status === "ready"
																? t.assetStatusReady
																: a.status === "failed"
																	? t.assetStatusFailed
																	: t.assetStatusPending}
														</Badge>
														{info.error !== undefined ? (
															<span className="ml-2 text-xs text-destructive">{info.error}</span>
														) : null}
													</TableCell>
													<TableCell className="text-right">
														{info.dominantColor !== undefined ? (
															<span
																className="inline-block size-4 rounded border border-border align-middle"
																style={{ background: info.dominantColor }}
															/>
														) : null}
													</TableCell>
												</TableRow>
											);
										})}
									</TableBody>
								</Table>
							)}
						</CardContent>
					</Card>
				</div>
			</EditorSection>
		</div>
	);

	const isColorValue = (v: string) => /^(#|oklch|oklab|rgb|rgba|hsl|hsla|color\()/.test(v.trim());

	const renderTokensTab = () => {
		const schemeVars = {
			...(scheme === "light" ? previewTokens.light : previewTokens.dark),
			...fontVars,
		};
		const entries = Object.entries(schemeVars).sort(([a], [b]) => a.localeCompare(b));
		const colorEntries = entries.filter(([, v]) => isColorValue(v));
		const radius = themeRadius(currentSeeds);
		return (
			<TabsContent value="tokens" className="mt-0 space-y-6">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-sm text-muted-foreground">{t.tokensDescription}</p>
					{schemeToggle}
				</div>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">
							{scheme === "light" ? t.schemeLight : t.schemeDark} — {t.tabColors}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
							{colorEntries.map(([name, value]) => (
								<div
									key={name}
									className="flex items-center gap-3 rounded-lg border border-border p-2.5"
								>
									<span
										className="size-9 shrink-0 rounded-md border border-border"
										style={{ background: value }}
									/>
									<div className="min-w-0">
										<p className="font-mono text-xs">{name}</p>
										<p className="truncate font-mono text-[10px] text-muted-foreground">{value}</p>
									</div>
								</div>
							))}
						</div>
					</CardContent>
				</Card>

				<div className="grid gap-6 lg:grid-cols-2">
					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.contrastTitle}</CardTitle>
						</CardHeader>
						<CardContent className="grid gap-4">
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
						</CardContent>
					</Card>

					<Card>
						<CardHeader>
							<CardTitle className="text-sm">{t.fontsTitle}</CardTitle>
						</CardHeader>
						<CardContent className="space-y-4">
							{(
								[
									["heading", "Aa — Display heading"],
									["sans", "Aa — Body text, buttons and inputs"],
									["mono", "Aa — Code and identifiers"],
								] as const
							).map(([slot, sample]) => (
								<div key={slot} className="space-y-1">
									<p className="text-xs text-muted-foreground">
										{slot === "heading" ? t.fontHeading : slot === "sans" ? t.fontSans : t.fontMono}
									</p>
									<p
										className="text-lg"
										style={{ fontFamily: fontVars[`--font-${slot === "sans" ? "body" : slot}`] }}
									>
										{sample}
									</p>
								</div>
							))}
						</CardContent>
					</Card>
				</div>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Radius — {radius}</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-wrap items-end gap-4">
						{["4px", "8px", radius, "1rem", "50%"].map((r) => (
							<div key={r} className="flex flex-col items-center gap-1.5">
								<span
									className="block size-12 border-2 border-primary bg-primary/15"
									style={{ borderRadius: r }}
								/>
								<span className="font-mono text-[10px] text-muted-foreground">{r}</span>
								<span className="font-mono text-[10px] text-muted-foreground">
									{r === radius ? "theme" : ""}
								</span>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">Token reference</CardTitle>
						<CardDescription className="text-xs">
							{scheme === "light" ? t.schemeLight : t.schemeDark} custom properties
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="max-h-96 overflow-auto rounded-lg border border-border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>Token</TableHead>
										<TableHead>Value</TableHead>
										<TableHead className="w-12 text-right">Swatch</TableHead>
									</TableRow>
								</TableHeader>
								<TableBody>
									{entries.map(([name, value]) => (
										<TableRow key={name}>
											<TableCell className="font-mono text-xs">{name}</TableCell>
											<TableCell className="font-mono text-xs text-muted-foreground">
												{value}
											</TableCell>
											<TableCell className="text-right">
												{isColorValue(value) ? (
													<span
														className="ml-auto inline-block size-4 rounded border border-border"
														style={{ background: value }}
													/>
												) : null}
											</TableCell>
										</TableRow>
									))}
								</TableBody>
							</Table>
						</div>
					</CardContent>
				</Card>
			</TabsContent>
		);
	};

	const schemeToggle = (
		<div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
			{(["light", "dark"] as const).map((s) => (
				<button
					key={s}
					type="button"
					onClick={() => setScheme(s)}
					className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
						scheme === s
							? "bg-muted text-foreground"
							: "text-muted-foreground hover:text-foreground"
					}`}
				>
					{s === "light" ? t.schemeLight : t.schemeDark}
				</button>
			))}
		</div>
	);

	const renderComponentsTab = () => (
		<TabsContent value="components" className="mt-0">
			<div className="mb-4 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">{t.componentsDescription}</p>
				{schemeToggle}
			</div>
			<div style={schemeStyle} className={scheme === "dark" ? "dark space-y-6" : "space-y-6"}>
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.galleryButtons}</CardTitle>
					</CardHeader>
					<CardContent className="flex flex-wrap items-center gap-2">
						<Button>Default</Button>
						<Button variant="secondary">Secondary</Button>
						<Button variant="outline">Outline</Button>
						<Button variant="ghost">Ghost</Button>
						<Button variant="destructive">Destructive</Button>
						<Button variant="link">Link</Button>
						<Button size="sm">Small</Button>
						<Button size="lg">Large</Button>
						<Button disabled>Disabled</Button>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.galleryForms}</CardTitle>
					</CardHeader>
					<CardContent className="grid max-w-2xl gap-4">
						<div className="space-y-1.5">
							<Label htmlFor="g-input">Input</Label>
							<Input id="g-input" placeholder="Placeholder text" />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="g-textarea">Textarea</Label>
							<Textarea id="g-textarea" placeholder="Longer content…" rows={3} />
						</div>
						<div className="space-y-1.5">
							<Label>Native select styled control</Label>
							<Select defaultValue="a">
								<SelectTrigger className="w-full sm:w-64">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="a">Option A</SelectItem>
									<SelectItem value="b">Option B</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Checkbox defaultChecked /> Option one
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox /> Option two
							</label>
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Switch defaultChecked /> Notifications
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Switch /> Marketing emails
							</label>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.galleryFeedback}</CardTitle>
					</CardHeader>
					<CardContent className="grid max-w-2xl gap-4">
						<Alert>
							<AlertTitle>Heads up</AlertTitle>
							<AlertDescription>Your changes were applied to the draft theme.</AlertDescription>
						</Alert>
						<Alert variant="destructive">
							<AlertTitle>Something failed</AlertTitle>
							<AlertDescription>Contrast ratio is below AA for this pairing.</AlertDescription>
						</Alert>
						<div className="flex flex-wrap gap-2">
							<Badge>Default</Badge>
							<Badge variant="secondary">Secondary</Badge>
							<Badge variant="outline">Outline</Badge>
							<Badge variant="destructive">Destructive</Badge>
						</div>
						<div className="space-y-1.5">
							<Progress value={64} />
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.gallerySurfaces}</CardTitle>
					</CardHeader>
					<CardContent className="grid max-w-2xl gap-4">
						<div className="flex items-center gap-3">
							<Avatar>
								<AvatarFallback>KT</AvatarFallback>
							</Avatar>
							<div>
								<p className="text-sm font-medium">KTB Health</p>
								<p className="text-xs text-muted-foreground">Platform team</p>
							</div>
							<Badge variant="secondary" className="ml-auto">
								Admin
							</Badge>
						</div>
						<Separator />
						<div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
							Muted surface — cards, separators and muted fills pick up the draft tokens.
						</div>
					</CardContent>
				</Card>
			</div>
		</TabsContent>
	);

	const renderBlocksTab = () => (
		<TabsContent value="blocks" className="mt-0">
			<div className="mb-4 flex items-center justify-between gap-3">
				<p className="text-sm text-muted-foreground">{t.blocksDescription}</p>
				{schemeToggle}
			</div>
			<div style={schemeStyle} className={scheme === "dark" ? "dark space-y-6" : "space-y-6"}>
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.blockStats}</CardTitle>
					</CardHeader>
					<CardContent className="grid gap-4 sm:grid-cols-3">
						{[
							["Active themes", "12", "+2"],
							["Assets ready", "48", "+8"],
							["Contrast failures", "3", "-1"],
						].map(([label, value, delta]) => (
							<div key={label} className="rounded-lg border border-border p-4">
								<p className="text-xs text-muted-foreground">{label}</p>
								<div className="mt-1 flex items-baseline gap-2">
									<span className="text-2xl font-semibold">{value}</span>
									<Badge variant={delta.startsWith("-") ? "secondary" : "default"}>{delta}</Badge>
								</div>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.blockSettings}</CardTitle>
					</CardHeader>
					<CardContent className="max-w-xl space-y-4">
						<div className="space-y-1.5">
							<Label htmlFor="b-name">Display name</Label>
							<Input id="b-name" defaultValue={appName || "KTB Health"} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="b-desc">Description</Label>
							<Textarea
								id="b-desc"
								defaultValue="White-label theme for the platform shell."
								rows={2}
							/>
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Switch defaultChecked /> Enabled
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox defaultChecked /> High contrast
							</label>
						</div>
						<div className="flex gap-2">
							<Button size="sm">Save changes</Button>
							<Button size="sm" variant="outline">
								Reset
							</Button>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.blockEmpty}</CardTitle>
					</CardHeader>
					<CardContent>
						<Empty className="border">
							<EmptyHeader>
								<EmptyTitle>No themes yet</EmptyTitle>
								<EmptyDescription>
									Create a theme to start customizing the platform shell.
								</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button size="sm">New theme</Button>
							</EmptyContent>
						</Empty>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.blockTable}</CardTitle>
					</CardHeader>
					<CardContent>
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Scope</TableHead>
									<TableHead className="text-right">Version</TableHead>
									<TableHead className="text-right">Status</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{[
									["KTB default", "platform", "3", "Ready"],
									["Acme brand", "tenant", "1", "Draft"],
									["Clinic portal", "portal-instance", "7", "Ready"],
								].map(([name, sc, version, status]) => (
									<TableRow key={name}>
										<TableCell className="text-sm">{name}</TableCell>
										<TableCell className="text-sm text-muted-foreground">{sc}</TableCell>
										<TableCell className="text-right font-mono text-xs">v{version}</TableCell>
										<TableCell className="text-right">
											<Badge variant={status === "Ready" ? "default" : "secondary"}>{status}</Badge>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					</CardContent>
				</Card>
			</div>
		</TabsContent>
	);

	if (loadState === "missing") {
		return (
			<PageContainer className="max-w-none">
				<div className="flex items-center gap-3">
					<Button variant="ghost" size="sm" onClick={() => void goBack()}>
						<ArrowLeftIcon className="size-4" />
						{t.editorBack}
					</Button>
				</div>
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{t.editorNotFound}</EmptyTitle>
					</EmptyHeader>
				</Empty>
				<Toast toast={toast} onClose={() => setToast(null)} />
			</PageContainer>
		);
	}

	if (loadState === "loading" || theme === null) {
		return (
			<PageContainer className="max-w-none">
				<div className="flex items-center gap-3 text-muted-foreground">
					<Spinner className="size-4" />
					<span className="text-sm">{t.editorThemeLabel}…</span>
				</div>
			</PageContainer>
		);
	}

	return (
		<PageContainer className="max-w-none">
			<div className="flex flex-wrap items-center gap-3">
				<Button variant="ghost" size="sm" onClick={() => void goBack()}>
					<ArrowLeftIcon className="size-4" />
					{t.editorBack}
				</Button>
				<div className="min-w-0">
					<h1 className="truncate text-lg font-semibold">
						{t.editorThemeLabel}: {appName !== "" ? appName : theme.scopeId || `#${theme.id}`}
					</h1>
					<p className="flex items-center gap-2 text-sm text-muted-foreground">
						{scopeLabel(theme.scope)} · #{theme.id}
						{theme.preview === true ? <Badge variant="secondary">{t.previewAction}</Badge> : null}
						{touched ? <Badge variant="outline">{t.dirtyBadge}</Badge> : null}
					</p>
				</div>
				<div className="ml-auto flex items-center gap-2">
					<Button variant="outline" onClick={() => void preview()} disabled={busy !== null}>
						{busy === "preview" ? <Spinner className="size-4" /> : null}
						{busy === "preview" ? t.previewing : t.previewAction}
					</Button>
					<Button onClick={() => void publish()} disabled={saving}>
						{saving ? <Spinner className="size-4" /> : null}
						{saving ? t.publishing : t.publish}
					</Button>
				</div>
			</div>

			{notice !== null ? <p className="text-sm text-muted-foreground">{notice}</p> : null}

			<div className="grid gap-6 lg:grid-cols-[340px_minmax(0,1fr)]">
				<aside className="space-y-4 lg:sticky lg:top-6 lg:max-h-[calc(100dvh-9rem)] lg:overflow-y-auto lg:pr-1">
					{renderSettings()}
				</aside>

				<div className="min-w-0">
					<Tabs value={tab} onValueChange={(v) => setTab(v as EditorTab)}>
						<TabsList className="mb-4">
							<TabsTrigger value="tokens">{t.tabTokens}</TabsTrigger>
							<TabsTrigger value="components">{t.tabComponents}</TabsTrigger>
							<TabsTrigger value="blocks">{t.tabBlocks}</TabsTrigger>
						</TabsList>
						{renderTokensTab()}
						{renderComponentsTab()}
						{renderBlocksTab()}
					</Tabs>
				</div>
			</div>

			<Toast toast={toast} onClose={() => setToast(null)} />
		</PageContainer>
	);
}

