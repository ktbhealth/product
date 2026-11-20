import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useRouter, useSearch } from "@tanstack/react-router";

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
import { ColorPicker } from "@ktbhealth/ui/components/color-picker";
import {
	Combobox,
	ComboboxCollection,
	ComboboxContent,
	ComboboxEmpty,
	ComboboxGroup,
	ComboboxInput,
	ComboboxItem,
	ComboboxLabel,
	ComboboxList,
} from "@ktbhealth/ui/components/combobox";
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
import { ScrollArea } from "@ktbhealth/ui/components/scroll-area";
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
	listThemeFontSourcesFn,
	publishThemeFn,
	setThemePreviewFn,
} from "../fns.ts";
import { fontPreviewModel } from "../font-preview.ts";
import { themeMessages, type ThemeMessages } from "../i18n.ts";
import { contrastReport, deriveThemeTokens, themeRadius, type ContrastPair } from "../palette.ts";
import { fontCssVars, fontVariationSettingsForSlot } from "../present.ts";
import type {
	ResolvedTheme,
	ThemeAssetKind,
	ThemeAssetSummary,
	ThemeFontConfig,
	ThemeFontSlot,
	ThemeFontSource,
	ThemeFontSourceOption,
	ThemeScopeKind,
	ThemeSeeds,
	ThemeSummary,
} from "../types.ts";

export interface ThemeEditorPageData {
	readonly themes: readonly ThemeSummary[];
}

type EditorTab = "tokens" | "components" | "blocks";
type SettingsSection = "general" | "colors" | "typography" | "assets";
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

/** Select value for "no managed source" — the slot falls back to the
 * free-form `families.<slot>` name. */
const CUSTOM_FONT_SOURCE = "custom";

const fontSourceKey = (providerId: number, family: string) => `src:${providerId}:${family}`;

const fontSlotLabel = (slot: ThemeFontSlot, t: ThemeMessages): string =>
	slot === "sans" ? t.fontSans : slot === "heading" ? t.fontHeading : t.fontMono;

/** One row in the managed-source picker. `key` keeps the picker's
 * `src:<providerId>:<family>` value encoding; `search` is the lowercase
 * haystack the combobox filter matches (provider, family, weights). */
interface FontSourcePick {
	readonly key: string;
	readonly label: string;
	readonly search: string;
	readonly source: ThemeFontSource | null;
}

/** One section of the picker — the leading group holds `custom` plus
 * any stale binding (no provider heading); each catalog group is keyed
 * by provider name. `label` is null when the heading would only repeat
 * the "Provider — Family" row labels (single-provider catalog). */
interface FontSourcePickGroup {
	readonly key: string;
	readonly label: string | null;
	readonly items: readonly FontSourcePick[];
}

const fontSourceOptionLabel = (o: ThemeFontSourceOption): string =>
	o.weights.length === 0
		? `${o.providerName} — ${o.family}`
		: `${o.providerName} — ${o.family} (${o.weights.join(", ")})`;

/**
 * Searchable managed-source picker for one font slot — the ui Combobox
 * (Base UI) so the catalog stays usable with dozens of families across
 * providers. The input doubles as trigger and filter; `custom` clears
 * the slot's binding back to the free-form family name.
 */
function ManagedSourcePicker({
	slotLabel,
	current,
	sources,
	t,
	onSelect,
}: {
	slotLabel: string;
	current: ThemeFontSource | null;
	sources: readonly ThemeFontSourceOption[];
	t: ThemeMessages;
	onSelect: (source: ThemeFontSource | null) => void;
}) {
	const items = useMemo<readonly FontSourcePickGroup[]>(() => {
		// A stored source missing from the ready catalog (provider
		// disabled/removed since publish) still renders as its own
		// option so the picker shows the binding instead of a blank input.
		const stale =
			current !== null &&
			!sources.some((o) => o.providerId === current.providerId && o.family === current.family)
				? current
				: null;
		const stalePick: FontSourcePick[] =
			stale === null
				? []
				: [
						{
							key: fontSourceKey(stale.providerId, stale.family),
							label: stale.family,
							search: stale.family.toLowerCase(),
							source: stale,
						},
					];
		// Cluster catalog picks under provider headings — sorted by
		// provider then family so same-provider families scan together
		// regardless of catalog order.
		const sorted = [...sources].sort(
			(a, b) =>
				a.providerName.localeCompare(b.providerName) ||
				a.providerId - b.providerId ||
				a.family.localeCompare(b.family),
		);
		const providerCount = new Set(sorted.map((o) => o.providerName)).size;
		const byProvider = new Map<string, FontSourcePick[]>();
		for (const o of sorted) {
			const pick: FontSourcePick = {
				key: fontSourceKey(o.providerId, o.family),
				label: fontSourceOptionLabel(o),
				search: [o.providerName, o.family, ...o.weights.map(String)].join(" ").toLowerCase(),
				source: { providerId: o.providerId, family: o.family },
			};
			const group = byProvider.get(o.providerName);
			if (group === undefined) {
				byProvider.set(o.providerName, [pick]);
			} else {
				group.push(pick);
			}
		}
		return [
			{
				key: "custom",
				label: null,
				items: [
					{
						key: CUSTOM_FONT_SOURCE,
						label: t.fontSourceCustom,
						search: t.fontSourceCustom.toLowerCase(),
						source: null,
					},
					...stalePick,
				],
			},
			...[...byProvider.entries()].map(([providerName, picks]) => ({
				key: `provider:${providerName}`,
				label: providerCount > 1 ? providerName : null,
				items: picks,
			})),
		];
	}, [current, sources, t]);

	const selectedKey =
		current === null ? CUSTOM_FONT_SOURCE : fontSourceKey(current.providerId, current.family);
	// `custom` is always an item and a non-null `current` is either in the
	// catalog or injected above as the stale pick — the lookup cannot miss.
	const selected = items.flatMap((group) => group.items).find((item) => item.key === selectedKey)!;

	return (
		<Combobox
			items={items}
			value={selected}
			onValueChange={(item: FontSourcePick | null) => onSelect(item?.source ?? null)}
			itemToStringLabel={(item: FontSourcePick) => item.label}
			isItemEqualToValue={(a: FontSourcePick, b: FontSourcePick) => a.key === b.key}
			filter={(item: FontSourcePick, query: string) => item.search.includes(query.toLowerCase())}
			autoHighlight
		>
			<ComboboxInput
				className="w-full"
				placeholder={t.fontSourceSearchPlaceholder}
				aria-label={`${slotLabel} — ${t.fontSourceLabel}`}
			/>
			<ComboboxContent>
				<ComboboxEmpty>{t.fontSourceNoResults}</ComboboxEmpty>
				<ComboboxList>
					{(group: FontSourcePickGroup) => (
						<ComboboxGroup key={group.key} items={group.items}>
							{group.label === null ? null : <ComboboxLabel>{group.label}</ComboboxLabel>}
							<ComboboxCollection>
								{(item: FontSourcePick) => (
									<ComboboxItem key={item.key} value={item}>
										{item.label}
									</ComboboxItem>
								)}
							</ComboboxCollection>
						</ComboboxGroup>
					)}
				</ComboboxList>
			</ComboboxContent>
		</Combobox>
	);
}

/**
 * Single variable-font axis pin — a compact numeric input for one
 * `axisSettings.<slot>.<tag>` value. Local text state keeps
 * intermediate keystrokes ("-", "1.") editable while every parseable
 * number commits immediately; empty text clears the pin. The effect
 * re-syncs the draft when the committed value changes externally
 * (theme reload).
 */
function AxisValueInput({
	value,
	onValue,
	...rest
}: {
	readonly value: number | undefined;
	readonly onValue: (value: number | undefined) => void;
	readonly "aria-label"?: string;
	readonly className?: string;
	readonly placeholder?: string;
}) {
	const [text, setText] = useState(value === undefined ? "" : String(value));
	const committed = useRef(value);
	useEffect(() => {
		if (value === committed.current) return;
		committed.current = value;
		setText(value === undefined ? "" : String(value));
	}, [value]);
	return (
		<Input
			{...rest}
			value={text}
			onChange={(e) => {
				const raw = e.target.value;
				setText(raw);
				const trimmed = raw.trim();
				if (trimmed === "") {
					onValue(undefined);
					return;
				}
				const parsed = Number(trimmed);
				if (Number.isFinite(parsed)) onValue(parsed);
			}}
		/>
	);
}

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
		<div className="space-y-2">
			{keys.map((key, i) => (
				<div key={key} className="flex items-center gap-3">
					<Label className="w-24 shrink-0 text-xs">{labels[i]}</Label>
					{key === "radius" ? (
						<Input
							value={fields[key]}
							onChange={(e) => onChange({ ...fields, [key]: e.target.value })}
							placeholder="0.45rem"
							className="font-mono text-xs"
						/>
					) : (
						<ColorPicker
							value={fields[key]}
							onChange={(v) => onChange({ ...fields, [key]: v })}
							placeholder="oklch(…) / #rrggbb"
							className="flex-1"
						/>
					)}
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
	t,
}: {
	report: readonly ContrastPair[];
	title: string;
	passLabel: string;
	failLabel: string;
	t: ThemeMessages;
}) {
	return (
		<div className="overflow-hidden rounded-lg border border-border">
			<header className="border-b border-border px-3 py-2">
				<h3 className="text-sm font-medium">{title}</h3>
			</header>
			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{t.contrastColPairing}</TableHead>
						<TableHead className="text-right">{t.contrastColRatio}</TableHead>
						<TableHead className="text-right">{t.contrastColMin}</TableHead>
						<TableHead className="text-right">AA</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{report.map((p) => {
						/* v8 ignore next -- derived foregrounds are AA-clamped so pairs never fail */
						const variant = p.ok ? "default" : "destructive";
						/* v8 ignore next -- derived foregrounds are AA-clamped so pairs never fail */
						const label = p.ok ? passLabel : failLabel;
						return (
							<TableRow key={p.name}>
								<TableCell className="font-mono text-xs">{p.name}</TableCell>
								<TableCell className="text-right font-mono text-xs">{p.ratio}:1</TableCell>
								<TableCell className="text-right text-xs text-muted-foreground">
									{p.min}:1
								</TableCell>
								<TableCell className="text-right">
									<Badge variant={variant}>{label}</Badge>
								</TableCell>
							</TableRow>
						);
					})}
				</TableBody>
			</Table>
		</div>
	);
}

/** Palette strip: one chip per derived surface/brand color. */
/* v8 ignore next -- dead code: no view renders PaletteStrip */
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
	const [fontSources, setFontSources] = useState<readonly ThemeFontSourceOption[]>([]);
	const [scope, setScope] = useState<ThemeScopeKind>("tenant");
	const [scopeId, setScopeId] = useState("");
	const [appName, setAppName] = useState("");
	const [assets, setAssets] = useState<readonly ThemeAssetSummary[]>([]);
	const [tab, setTab] = useState<EditorTab>("tokens");
	const [section, setSection] = useState<SettingsSection>("general");
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
				const [th, assetRows, sourceRows] = await Promise.all([
					getThemeFn({ data: { id } }) as Promise<ResolvedTheme | null>,
					listThemeAssetsFn({ data: { themeId: id } }) as Promise<readonly ThemeAssetSummary[]>,
					// Managed-source catalog — independent of the theme row;
					// a failure just hides the picker (free-form families
					// keep working), same degradation as an absent fonts
					// plugin.
					listThemeFontSourcesFn()
						.then((rows) => rows as readonly ThemeFontSourceOption[])
						.catch(() => [] as readonly ThemeFontSourceOption[]),
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
				setFontSources(sourceRows);
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
	// Live per-slot specimens for the Typography tab: the draft fonts
	// config resolved against the managed-source catalog, plus the
	// stylesheet links / @font-face CSS that make the fonts actually
	// load in the editor (managed self-host faces come from the
	// persisted row's resolved fontFaceCss — unpublished picks fall
	// back honestly until publish).
	const fontPreview = useMemo(
		() =>
			fontPreviewModel(fonts, fontSources, {
				faceCss: theme?.fontFaceCss ?? "",
				delivery: theme?.fonts?.delivery ?? null,
			}),
		[fonts, fontSources, theme],
	);
	const [previewWeights, setPreviewWeights] = useState<Partial<Record<ThemeFontSlot, number>>>({});
	const slotPreviewWeight = (slot: ThemeFontSlot, weights: readonly number[]): number => {
		const selected = previewWeights[slot];
		if (selected !== undefined && weights.includes(selected)) return selected;
		return weights.includes(400) ? 400 : weights[0];
	};
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

	// Leaving the editor by any route (breadcrumb, sidebar, browser
	// back) discards an untouched auto-created draft — same rule the
	// old Back button enforced. The microtask defers past StrictMode's
	// dev-only effect replay so only a real unmount deletes.
	const touchedRef = useRef(touched);
	const themeRef = useRef(theme);
	const aliveRef = useRef(true);
	useEffect(() => {
		touchedRef.current = touched;
		themeRef.current = theme;
	});
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
			queueMicrotask(() => {
				if (aliveRef.current || !fresh || touchedRef.current || themeRef.current === null) {
					return;
				}
				void deleteThemeFn({ data: { id: themeRef.current.id } })
					.then(() => sessionStorage.setItem("ktb-theme-discarded", "1"))
					.catch(() => {});
			});
		};
	}, [fresh]);

	const publish = async () => {
		/* v8 ignore next -- the publish button is disabled while saving and the page only renders with a theme */
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
					? /* v8 ignore next -- publish() returns early while theme is null */ prev
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
		/* v8 ignore next -- the preview button is disabled while busy and the page only renders with a theme */
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
		/* v8 ignore next -- uploads are only reachable after the theme loads */
		if (theme === null) return false;
		setBusy(`upload-${kind}`);
		setNotice(null);
		try {
			const form = new FormData();
			form.set("file", file);
			form.set("themeId", String(theme.id));
			form.set("kind", kind);
			if (kind === "font") {
				/* v8 ignore start -- family/slot defaults are defensive: the only call site passes both */
				form.set("family", (family ?? "").trim() || file.name.replace(/\.[^.]+$/, ""));
				form.set("slot", slot ?? "sans");
				/* v8 ignore stop */
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
		/* v8 ignore next -- the fetch button is disabled while the family is blank and the page only renders with a theme */
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
	const setFontSource = (slot: ThemeFontSlot, source: ThemeFontSource | null) => {
		mark();
		setFonts((f) => ({
			...(f ?? {}),
			delivery: f?.delivery ?? "self-host",
			sources: { ...(f?.sources ?? {}), [slot]: source },
		}));
	};
	// Pin/unpin one variable-font axis value for a slot — empty input
	// clears the tag; empty slot maps are dropped so the stored JSON
	// stays tidy (axisSettings rides fonts verbatim to publish).
	const setFontAxisPin = (slot: ThemeFontSlot, tag: string, value: number | undefined) => {
		mark();
		setFonts((f) => {
			// Pin inputs only render once a fonts draft exists (axes come
			// from stored assets or catalog sources), so `f` is never null
			// here — unlike the family/source setters above.
			/* v8 ignore next -- unreachable: no axis input renders without a fonts draft */
			const draft = (f ?? { delivery: "self-host" }) as ThemeFontConfig;
			const axisSettings = { ...(draft.axisSettings ?? {}) };
			const slotPins = { ...(axisSettings[slot] ?? {}) };
			if (value === undefined) {
				delete slotPins[tag];
			} else {
				slotPins[tag] = value;
			}
			if (Object.keys(slotPins).length === 0) {
				delete axisSettings[slot];
			} else {
				axisSettings[slot] = slotPins;
			}
			return {
				...draft,
				delivery: draft.delivery ?? "self-host",
				axisSettings: Object.keys(axisSettings).length === 0 ? undefined : axisSettings,
			};
		});
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

	const renderGeneralSection = () => (
		<TabsContent value="general" className="mt-0 min-w-0 space-y-4 pr-3">
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
		</TabsContent>
	);

	const renderColorsSection = () => (
		<TabsContent value="colors" className="mt-0 min-w-0 space-y-4 pr-3">
			<p className="text-sm text-muted-foreground">{t.seedsDescription}</p>
			<div className="space-y-4">
				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.seedsTitle}</CardTitle>
					</CardHeader>
					<CardContent>
						<SeedInputs
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
		</TabsContent>
	);

	const renderTypographySection = () => (
		<TabsContent value="typography" className="mt-0 min-w-0 space-y-4 pr-3">
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
					{fontSources.length > 0 ? (
						<div className="space-y-1.5">
							<Label>{t.fontsSourcesLabel}</Label>
							<div className="space-y-2">
								{FONT_SLOT_ITEMS.map((slot) => {
									const slotLabel = fontSlotLabel(slot, t);
									return (
										<div key={slot} className="flex items-center gap-3">
											<Label className="w-24 shrink-0 text-xs">{slotLabel}</Label>
											<div className="min-w-0 flex-1">
												<ManagedSourcePicker
													slotLabel={slotLabel}
													current={fonts?.sources?.[slot] ?? null}
													sources={fontSources}
													t={t}
													onSelect={(source) => setFontSource(slot, source)}
												/>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					) : null}
					<div className="space-y-1.5">
						<Label>{t.fontsFamiliesLabel}</Label>
						<div className="space-y-2">
							{fontPreview.slots.map((sp) => {
								const slot = sp.slot;
								const slotLabel = fontSlotLabel(slot, t);
								// Pinnable axes of the slot's resolved family —
								// stored asset faces ∪ managed catalog meta.axes
								// resolved client-side by font-preview.
								const axes = sp.axes;
								return (
									<div key={slot} className="space-y-1">
										<div className="flex items-center gap-3">
											<Label htmlFor={`font-${slot}`} className="w-24 shrink-0 text-xs">
												{slotLabel}
											</Label>
											<Input
												id={`font-${slot}`}
												value={fonts?.families?.[slot] ?? ""}
												onChange={(e) => setFontFamilySlot(slot, e.target.value)}
												placeholder="Inter, system-ui, sans-serif"
												className="font-mono text-xs"
											/>
										</div>
										{axes.length > 0 ? (
											<div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[6.75rem]">
												<span className="text-[10px] text-muted-foreground">{t.fontAxesLabel}</span>
												{axes.map((axis) => (
													<span key={axis.tag} className="inline-flex items-center gap-1">
														<span
															className="font-mono text-[10px] text-muted-foreground"
															title={`${axis.min} – ${axis.max}`}
														>
															{axis.tag}
														</span>
														<AxisValueInput
															aria-label={`${slotLabel} ${axis.tag}`}
															value={fonts?.axisSettings?.[slot]?.[axis.tag]}
															onValue={(n) => setFontAxisPin(slot, axis.tag, n)}
															placeholder={String(axis.default)}
															className="h-7 w-16 px-1.5 font-mono text-[11px]"
														/>
													</span>
												))}
											</div>
										) : null}
									</div>
								);
							})}
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
					<div className="space-y-1.5">
						<Label className="text-xs">{t.fontPreviewLabel}</Label>
						<div className="space-y-3 rounded-lg border border-border p-3">
							{fontPreview.slots.map((sp) => {
								const weight = slotPreviewWeight(sp.slot, sp.weights);
								const slotLabel = fontSlotLabel(sp.slot, t);
								return (
									<div key={sp.slot} className="flex items-start gap-3">
										<div className="w-24 shrink-0 space-y-0.5 pt-1">
											<p className="text-xs text-muted-foreground">{slotLabel}</p>
											{sp.family !== null ? (
												<p className="truncate font-mono text-[10px] text-muted-foreground">
													{sp.family}
												</p>
											) : null}
										</div>
										<div className="min-w-0 flex-1 space-y-0.5">
											<p
												className="text-lg leading-8"
												style={{
													fontFamily: sp.fontFamily === "" ? undefined : sp.fontFamily,
													fontWeight: weight,
													fontVariationSettings:
														sp.fontVariationSettings === "" ? undefined : sp.fontVariationSettings,
												}}
											>
												Aa Bb Cc 123
											</p>
											<p
												className="truncate text-xs"
												style={{
													fontFamily: sp.fontFamily === "" ? undefined : sp.fontFamily,
													fontWeight: weight,
													fontVariationSettings:
														sp.fontVariationSettings === "" ? undefined : sp.fontVariationSettings,
												}}
											>
												{t.fontPreviewText}
											</p>
											{sp.weights.length > 1 ? (
												<div className="flex flex-wrap gap-1 pt-1">
													{sp.weights.map((w) => (
														<button
															key={w}
															type="button"
															aria-label={`${slotLabel} ${w}`}
															aria-pressed={w === weight}
															onClick={() =>
																setPreviewWeights((prev) => ({ ...prev, [sp.slot]: w }))
															}
															className={`rounded-md px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
																w === weight
																	? "bg-muted text-foreground"
																	: "text-muted-foreground hover:text-foreground"
															}`}
														>
															{w}
														</button>
													))}
												</div>
											) : null}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</CardContent>
			</Card>
		</TabsContent>
	);

	const renderAssetsSection = () => (
		<TabsContent value="assets" className="mt-0 min-w-0 space-y-4 pr-3">
			<p className="text-sm text-muted-foreground">{t.assetsNeedSave}</p>
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
												/* v8 ignore next -- the button is disabled while no file is selected */
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
											/* v8 ignore next -- the button is disabled while no file is selected */
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
								<Select value={googleSlot} onValueChange={(v) => setGoogleSlot(v as ThemeFontSlot)}>
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
										<TableHead>{t.colStatus}</TableHead>
										<TableHead className="text-right">{t.colColor}</TableHead>
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
		</TabsContent>
	);

	const renderSettings = () => (
		<Tabs
			value={section}
			onValueChange={(v) => setSection(v as SettingsSection)}
			className="flex min-h-0 min-w-0 flex-1 flex-col gap-3"
		>
			<TabsList className="grid h-8 w-full shrink-0 grid-cols-4 gap-1">
				<TabsTrigger value="general" className="min-w-0 truncate px-1">
					{t.tabGeneral}
				</TabsTrigger>
				<TabsTrigger value="colors" className="min-w-0 truncate px-1">
					{t.tabColors}
				</TabsTrigger>
				<TabsTrigger value="typography" className="min-w-0 truncate px-1">
					{t.tabTypography}
				</TabsTrigger>
				<TabsTrigger value="assets" className="min-w-0 truncate px-1">
					{t.tabAssets}
				</TabsTrigger>
			</TabsList>
			<ScrollArea className="h-[62dvh] min-h-0 w-full min-w-0 lg:h-[calc(100dvh-12rem)]">
				{renderGeneralSection()}
				{renderColorsSection()}
				{renderTypographySection()}
				{renderAssetsSection()}
			</ScrollArea>
		</Tabs>
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
								t={t}
							/>
							<ContrastTable
								report={darkReport}
								title={t.contrastDark}
								passLabel={t.contrastPass}
								failLabel={t.contrastFail}
								t={t}
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
									["heading", t.fontSampleHeading],
									["sans", t.fontSampleSans],
									["mono", t.fontSampleMono],
								] as const
							).map(([slot, sample]) => (
								<div key={slot} className="space-y-1">
									<p className="text-xs text-muted-foreground">{fontSlotLabel(slot, t)}</p>
									<p
										className="text-lg"
										style={{
											fontFamily: fontVars[`--font-${slot === "sans" ? "body" : slot}`],
											fontVariationSettings: fontVariationSettingsForSlot(fonts, slot) || undefined,
										}}
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
						<CardTitle className="text-sm">{t.radiusTitle(radius)}</CardTitle>
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
									{r === radius ? t.radiusCurrent : ""}
								</span>
							</div>
						))}
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.tokenRefTitle}</CardTitle>
						<CardDescription className="text-xs">
							{t.tokenRefDesc(scheme === "light" ? t.schemeLight : t.schemeDark)}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<div className="max-h-96 overflow-auto rounded-lg border border-border">
							<Table>
								<TableHeader>
									<TableRow>
										<TableHead>{t.tokenColToken}</TableHead>
										<TableHead>{t.tokenColValue}</TableHead>
										<TableHead className="w-12 text-right">{t.tokenColSwatch}</TableHead>
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
						<Button>{t.galleryBtnDefault}</Button>
						<Button variant="secondary">{t.galleryBtnSecondary}</Button>
						<Button variant="outline">{t.galleryBtnOutline}</Button>
						<Button variant="ghost">{t.galleryBtnGhost}</Button>
						<Button variant="destructive">{t.galleryBtnDestructive}</Button>
						<Button variant="link">{t.galleryBtnLink}</Button>
						<Button size="sm">{t.galleryBtnSmall}</Button>
						<Button size="lg">{t.galleryBtnLarge}</Button>
						<Button disabled>{t.galleryBtnDisabled}</Button>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle className="text-sm">{t.galleryForms}</CardTitle>
					</CardHeader>
					<CardContent className="grid max-w-2xl gap-4">
						<div className="space-y-1.5">
							<Label htmlFor="g-input">{t.galleryInputLabel}</Label>
							<Input id="g-input" placeholder={t.galleryInputPlaceholder} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="g-textarea">{t.galleryTextareaLabel}</Label>
							<Textarea id="g-textarea" placeholder={t.galleryTextareaPlaceholder} rows={3} />
						</div>
						<div className="space-y-1.5">
							<Label>{t.gallerySelectLabel}</Label>
							<Select defaultValue="a">
								<SelectTrigger className="w-full sm:w-64">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="a">{t.galleryOptionA}</SelectItem>
									<SelectItem value="b">{t.galleryOptionB}</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Checkbox defaultChecked /> {t.galleryOptionOne}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox /> {t.galleryOptionTwo}
							</label>
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Switch defaultChecked /> {t.gallerySwitchNotifications}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Switch /> {t.gallerySwitchMarketing}
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
							<AlertTitle>{t.galleryAlertOkTitle}</AlertTitle>
							<AlertDescription>{t.galleryAlertOkDesc}</AlertDescription>
						</Alert>
						<Alert variant="destructive">
							<AlertTitle>{t.galleryAlertFailTitle}</AlertTitle>
							<AlertDescription>{t.galleryAlertFailDesc}</AlertDescription>
						</Alert>
						<div className="flex flex-wrap gap-2">
							<Badge>{t.galleryBtnDefault}</Badge>
							<Badge variant="secondary">{t.galleryBtnSecondary}</Badge>
							<Badge variant="outline">{t.galleryBtnOutline}</Badge>
							<Badge variant="destructive">{t.galleryBtnDestructive}</Badge>
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
								<p className="text-xs text-muted-foreground">{t.gallerySurfaceTeam}</p>
							</div>
							<Badge variant="secondary" className="ml-auto">
								{t.gallerySurfaceRole}
							</Badge>
						</div>
						<Separator />
						<div className="rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
							{t.gallerySurfaceMuted}
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
							[t.galleryStatActive, "12", "+2"],
							[t.galleryStatAssets, "48", "+8"],
							[t.galleryStatContrast, "3", "-1"],
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
							<Label htmlFor="b-name">{t.gallerySettingsName}</Label>
							<Input id="b-name" defaultValue={appName || "KTB Health"} />
						</div>
						<div className="space-y-1.5">
							<Label htmlFor="b-desc">{t.gallerySettingsDesc}</Label>
							<Textarea id="b-desc" defaultValue={t.gallerySettingsDescValue} rows={2} />
						</div>
						<div className="flex items-center gap-6">
							<label className="flex items-center gap-2 text-sm">
								<Switch defaultChecked /> {t.gallerySettingsEnabled}
							</label>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox defaultChecked /> {t.gallerySettingsHighContrast}
							</label>
						</div>
						<div className="flex gap-2">
							<Button size="sm">{t.gallerySettingsSave}</Button>
							<Button size="sm" variant="outline">
								{t.gallerySettingsReset}
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
								<EmptyTitle>{t.galleryEmptyTitle}</EmptyTitle>
								<EmptyDescription>{t.galleryEmptyDesc}</EmptyDescription>
							</EmptyHeader>
							<EmptyContent>
								<Button size="sm">{t.newTheme}</Button>
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
									<TableHead>{t.colName}</TableHead>
									<TableHead>{t.colScope}</TableHead>
									<TableHead className="text-right">{t.colVersion}</TableHead>
									<TableHead className="text-right">{t.colStatus}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{[
									["KTB default", "platform", "3", t.galleryStatusReady],
									["Acme brand", "tenant", "1", t.galleryStatusDraft],
									["Clinic portal", "portal-instance", "7", t.galleryStatusReady],
								].map(([name, sc, version, status]) => (
									<TableRow key={name}>
										<TableCell className="text-sm">{name}</TableCell>
										<TableCell className="text-sm text-muted-foreground">{sc}</TableCell>
										<TableCell className="text-right font-mono text-xs">v{version}</TableCell>
										<TableCell className="text-right">
											<Badge variant={status === t.galleryStatusReady ? "default" : "secondary"}>
												{status}
											</Badge>
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
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{t.editorNotFound}</EmptyTitle>
					</EmptyHeader>
				</Empty>
				<Toast
					toast={toast}
					onClose={
						/* v8 ignore next -- nothing sets toast to a non-null value */ () => setToast(null)
					}
				/>
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
			{/* Draft font delivery for the live specimens — rendered at the
			 * page root so the Tokens/Components tabs' samples pick the
			 * fonts up too. Links cover googlefonts delivery; the style
			 * block carries self-host @font-face rules (persisted managed
			 * faces + any stored-asset gap the persisted row missed). */}
			{fontPreview.links.map((href) => (
				<link key={href} rel="stylesheet" href={href} />
			))}
			{fontPreview.faceCss !== "" ? (
				<style data-font-preview="" dangerouslySetInnerHTML={{ __html: fontPreview.faceCss }} />
			) : null}
			<div className="flex flex-wrap items-center gap-3">
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
				<aside className="min-w-0 lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100dvh-9rem)] lg:max-w-[340px] lg:flex-col">
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

			<Toast
				toast={toast}
				onClose={
					/* v8 ignore next -- nothing sets toast to a non-null value */ () => setToast(null)
				}
			/>
		</PageContainer>
	);
}
