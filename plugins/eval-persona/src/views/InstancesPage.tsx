import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { PencilIcon, PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@ktbhealth/ui/components/card";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import { Progress } from "@ktbhealth/ui/components/progress";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { listCredentialsFn } from "@ktb/eval-credentials/fns";
import type { CredentialCard } from "@ktb/eval-credentials";
import type { LlmEndpointPreset } from "@ktb/eval-consultation";

import {
	createInstanceFn,
	deleteEndpointFn,
	deleteInstanceFn,
	instanceDetailFn,
	listEndpointPresetsFn,
	listEndpointsFn,
	listInstancesFn,
	saveEndpointFn,
	spawnInstancesFn,
	startInstanceFn,
	testEndpointFn,
} from "../fns.ts";
import { evalLabMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { EndpointCard, InstanceCard, InstanceDetail, PersonaDefCard } from "../index.ts";

const TEMPLATE = "__template__";
const SECRET_NONE = "__none__";
const SECRET_CUSTOM = "__custom__";

// `secret_ref` holds either an env var NAME or `credential:<id>` —
// the select exposes the credential store, "custom" reveals the raw
// env-var input for the legacy path.
const secretSelectValue = (ref: string) =>
	ref === "" ? SECRET_NONE : ref.startsWith("credential:") ? ref : SECRET_CUSTOM;

const statusVariant = (s: string) =>
	s === "ready" || s === "done"
		? "default"
		: s === "failed" || s === "error"
			? "destructive"
			: s === "generating"
				? "secondary"
				: "outline";

const statusLabel = (s: string, m: ReturnType<typeof evalLabMessages>) =>
	s === "draft"
		? m.statusDraft
		: s === "generating"
			? m.statusGenerating
			: s === "ready"
				? m.statusReady
				: s === "failed"
					? m.statusFailed
					: s === "done"
						? m.statusDone
						: s === "error"
							? m.statusError
							: m.statusPending;

type EndpointForm = {
	id: number | null;
	name: string;
	kind: string;
	baseUrl: string;
	model: string;
	sessionId: string;
	secretRef: string;
	transport: string;
	timeoutMs: string;
	enabled: boolean;
};

const ENDPOINT_PRESETS: readonly {
	label: string;
	form: Partial<EndpointForm>;
}[] = [
	{
		label: "Ollama local",
		form: {
			kind: "openai",
			baseUrl: "http://127.0.0.1:11434/v1",
			model: "qwen2.5:7b-instruct-q4_K_M",
			name: "Ollama local",
		},
	},
	{
		label: "LM Studio",
		form: { kind: "openai", baseUrl: "http://127.0.0.1:1234/v1", model: "", name: "LM Studio" },
	},
	{
		label: "Gemini",
		form: {
			kind: "openai",
			baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
			model: "gemini-2.0-flash",
			name: "Gemini",
		},
	},
	{
		label: "Claude Code agent",
		form: { kind: "acp", baseUrl: "http://127.0.0.1:8787", model: "", name: "Claude Code agent" },
	},
];

const ENDPOINT_EMPTY: EndpointForm = {
	id: null,
	name: "",
	kind: "openai",
	baseUrl: "http://localhost:11434/v1",
	model: "",
	sessionId: "",
	secretRef: "",
	transport: "ws",
	timeoutMs: "60000",
	enabled: true,
};

const endpointFromCard = (e: EndpointCard): EndpointForm => ({
	id: e.id,
	name: e.name,
	kind: e.kind,
	baseUrl: e.baseUrl,
	model: e.model ?? "",
	sessionId: e.sessionId ?? "",
	secretRef: e.secretRef ?? "",
	transport: e.transport ?? "ws",
	timeoutMs: String(e.timeoutMs),
	enabled: e.enabled,
});

type InstanceForm = {
	name: string;
	mode: "selected" | "random";
	endpointId: string;
	defIds: ReadonlySet<number>;
	count: string;
	seed: string;
	minutes: string;
};

const INSTANCE_EMPTY: InstanceForm = {
	name: "",
	mode: "random",
	endpointId: TEMPLATE,
	defIds: new Set<number>(),
	count: "6",
	seed: "100",
	minutes: "15",
};

type SpawnForm = {
	count: number;
	endpointId: string;
	defCount: string;
};

const SPAWN_COUNTS = [5, 10, 20] as const;
const SPAWN_EMPTY: SpawnForm = { count: 5, endpointId: TEMPLATE, defCount: "3" };

/** Axis distribution bars — count personas per axis value. */
const distribution = (detail: InstanceDetail) => {
	const axes = ["region", "ageBand", "register", "specialty"] as const;
	return axes.map((axis) => {
		const counts = new Map<string, number>();
		for (const it of detail.items) {
			const v = it.persona?.[axis];
			if (typeof v === "string") counts.set(v, (counts.get(v) ?? 0) + 1);
		}
		const total = Math.max(
			1,
			[...counts.values()].reduce((a, b) => a + b, 0),
		);
		return {
			axis,
			entries: [...counts.entries()].map(([k, c]) => ({ k, c, pct: (c / total) * 100 })),
		};
	});
};

/** /platform/eval/instances view: pick personas (or sample randomly),
 * choose the LLM, watch generation progress per item. Endpoint CRUD
 * lives in the second tab. */
export function InstancesPage({
	instances: initial,
	defs,
	endpoints: initialEndpoints,
	i18n,
	locale,
}: {
	instances: readonly InstanceCard[];
	defs: readonly PersonaDefCard[];
	endpoints: readonly EndpointCard[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale: string;
}) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, evalLabMessages(locale));
	const router = useRouter();
	const [instances, setInstances] = useState<readonly InstanceCard[]>(initial);
	const [endpoints, setEndpoints] = useState<readonly EndpointCard[]>(initialEndpoints);
	const [form, setForm] = useState<InstanceForm | null>(null);
	const [epForm, setEpForm] = useState<EndpointForm | null>(null);
	const [spawnForm, setSpawnForm] = useState<SpawnForm | null>(null);
	const [creds, setCreds] = useState<readonly CredentialCard[]>([]);
	// Provider starter endpoints declared by the bound adapter — fetched
	// lazily with the credentials so provider URLs never ship in the
	// plugin bundle (provider-lockin).
	const [remotePresets, setRemotePresets] = useState<readonly LlmEndpointPreset[]>([]);
	const [secretCustom, setSecretCustom] = useState(false);
	const [detail, setDetail] = useState<InstanceDetail | null>(null);
	const [confirm, setConfirm] = useState<{ kind: "instance" | "endpoint"; id: number } | null>(
		null,
	);
	const [testResult, setTestResult] = useState<Record<number, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		const r = await listInstancesFn();
		if (r.ok) setInstances(r.data);
		const e = await listEndpointsFn();
		/* v8 ignore next -- endpoint list failure keeps stale cards; next poll retries */
		if (e.ok) setEndpoints(e.data);
	}, []);

	// Poll while any instance is generating — progress is durable in
	// the table, so polling alone drives the live view.
	const generating = instances.some((i) => i.status === "generating");
	useEffect(() => {
		if (!generating) return;
		const t = setInterval(() => {
			void (async () => {
				await refresh();
				if (detail !== null) {
					const d = await instanceDetailFn({ data: { id: detail.id } });
					if (d.ok && mounted.current) setDetail(d.data);
				}
			})();
		}, 2000);
		return () => clearInterval(t);
	}, [generating, detail?.id, refresh]);

	const openDetail = async (id: number) => {
		const d = await instanceDetailFn({ data: { id } });
		if (d.ok) setDetail(d.data);
	};

	// Credentials + adapter presets load lazily — only the endpoint
	// dialog consumes them.
	const openEndpoint = (f: EndpointForm) => {
		setEpForm(f);
		setSecretCustom(false);
		void (async () => {
			const [c, p] = await Promise.all([listCredentialsFn(), listEndpointPresetsFn()]);
			if (c.ok) setCreds(c.data);
			if (p.ok) setRemotePresets(p.data);
		})();
	};

	const create = async () => {
		/* v8 ignore next -- the dialog only renders when form is set */
		if (form === null) return;
		setBusy(true);
		setError(null);
		const r = await createInstanceFn({
			data: {
				name: form.name,
				mode: form.mode,
				...(form.endpointId !== TEMPLATE ? { endpointId: Number(form.endpointId) } : {}),
				...(form.mode === "selected" ? { defIds: [...form.defIds] } : {}),
				...(form.mode === "random" ? { count: Number(form.count) || 1 } : {}),
				...(form.seed !== "" ? { seed: Number(form.seed) } : {}),
				...(form.minutes !== "" ? { minutes: Number(form.minutes) } : {}),
			},
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setForm(null);
		await refresh();
	};

	const spawn = async () => {
		/* v8 ignore next -- the dialog only renders when spawnForm is set */
		if (spawnForm === null) return;
		setBusy(true);
		setError(null);
		const r = await spawnInstancesFn({
			data: {
				count: spawnForm.count,
				...(spawnForm.endpointId !== TEMPLATE ? { endpointId: Number(spawnForm.endpointId) } : {}),
				/* v8 ignore next -- Generate stays disabled while defCount is empty */
				...(spawnForm.defCount !== "" ? { defCount: Number(spawnForm.defCount) } : {}),
			},
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setSpawnForm(null);
		await refresh();
	};

	const start = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await startInstanceFn({ data: { id } });
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		await refresh();
	};

	const remove = async () => {
		/* v8 ignore next -- the confirm arm only renders when confirm is set */
		if (confirm === null) return;
		setBusy(true);
		setError(null);
		const r =
			confirm.kind === "instance"
				? await deleteInstanceFn({ data: { id: confirm.id } })
				: await deleteEndpointFn({ data: { id: confirm.id } });
		setBusy(false);
		setConfirm(null);
		if (r.ok) {
			if (detail?.id === confirm.id) setDetail(null);
			await refresh();
			void router.invalidate();
		} else {
			setError(m.actionFailed);
		}
	};

	const saveEndpoint = async () => {
		/* v8 ignore next -- the dialog only renders when epForm is set */
		if (epForm === null) return;
		setBusy(true);
		setError(null);
		const r = await saveEndpointFn({
			data: {
				...(epForm.id !== null ? { id: epForm.id } : {}),
				name: epForm.name,
				kind: epForm.kind as "acp" | "openai",
				baseUrl: epForm.baseUrl,
				...(epForm.model !== "" ? { model: epForm.model } : {}),
				...(epForm.sessionId !== "" ? { sessionId: epForm.sessionId } : {}),
				...(epForm.secretRef !== "" ? { secretRef: epForm.secretRef } : {}),
				...(epForm.kind === "acp" && epForm.transport !== ""
					? { transport: epForm.transport as "ws" | "child" | "ssh" }
					: {}),
				...(epForm.timeoutMs !== "" ? { timeoutMs: Number(epForm.timeoutMs) } : {}),
				enabled: epForm.enabled,
			},
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setEpForm(null);
		void router.invalidate();
	};

	const test = async (id: number) => {
		setTestResult((prev) => ({ ...prev, [id]: "…" }));
		const r = await testEndpointFn({ data: { id } });
		const failed =
			!r.ok && "data" in r && typeof r.data === "object" && r.data !== null
				? `: ${(r.data as { message?: string }).message ?? ""}`
				: "";
		setTestResult((prev) => ({
			...prev,
			[id]: r.ok ? m.testOk : `${m.testFailed}${failed}`,
		}));
	};

	return (
		<PageContainer>
			<PageHeader title={m.instancesTitle} description={m.instancesDesc} />
			<Tabs defaultValue="instances">
				<TabsList className="mb-4">
					<TabsTrigger value="instances">{m.instancesTitle}</TabsTrigger>
					<TabsTrigger value="endpoints">{m.endpointsTitle}</TabsTrigger>
				</TabsList>
				{error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}

				<TabsContent value="instances">
					<div className="mb-4 flex justify-end gap-2">
						<Button variant="outline" onClick={() => setSpawnForm({ ...SPAWN_EMPTY })}>
							<PlusIcon className="mr-1 size-4" />
							{m.spawnGenerators}
						</Button>
						<Button onClick={() => setForm({ ...INSTANCE_EMPTY, defIds: new Set<number>() })}>
							<PlusIcon className="mr-1 size-4" />
							{m.newInstance}
						</Button>
					</div>
					{instances.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>{m.instancesTitle}</EmptyTitle>
								<EmptyDescription>{m.emptyInstances}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="grid gap-3">
							{instances.map((i) => (
								<Card key={i.id}>
									<CardContent className="flex items-center justify-between gap-4 py-4">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-medium">{i.name}</span>
												<Badge variant={statusVariant(i.status)}>{statusLabel(i.status, m)}</Badge>
												<Badge variant="outline">
													{i.mode === "selected" ? m.modeSelected : m.modeRandom}
												</Badge>
												<span className="text-xs text-muted-foreground">
													{i.endpointName ?? m.endpointTemplate}
												</span>
											</div>
											<div className="mt-2 flex items-center gap-2">
												<Progress
													value={i.total === 0 ? 0 : (i.done / i.total) * 100}
													className="h-2 w-40"
												/>
												<span className="text-xs text-muted-foreground">
													{i.done}/{i.total} {m.items}
													{i.params.minutes ? ` · ${i.params.minutes}min` : ""}
												</span>
											</div>
										</div>
										<div className="flex shrink-0 gap-2">
											{i.status === "draft" && (
												<Button size="sm" disabled={busy} onClick={() => void start(i.id)}>
													<PlayIcon className="mr-1 size-3" />
													{m.start}
												</Button>
											)}
											<Button variant="outline" size="sm" onClick={() => void openDetail(i.id)}>
												{m.openDetail}
											</Button>
											{confirm?.kind === "instance" && confirm.id === i.id ? (
												<Button
													variant="destructive"
													size="sm"
													disabled={busy}
													onClick={() => void remove()}
												>
													{m.confirmDelete}
												</Button>
											) : (
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={() => setConfirm({ kind: "instance", id: i.id })}
												>
													<Trash2Icon className="size-3" />
												</Button>
											)}
										</div>
									</CardContent>
								</Card>
							))}
						</div>
					)}

					{detail !== null && (
						<Card className="mt-6">
							<CardHeader>
								<CardTitle className="flex items-center gap-2 text-base">
									{detail.name}
									<Badge variant={statusVariant(detail.status)}>
										{statusLabel(detail.status, m)}
									</Badge>
									<span className="text-sm font-normal text-muted-foreground">
										{detail.done}/{detail.total} · {detail.pct}%
									</span>
								</CardTitle>
							</CardHeader>
							<CardContent className="grid gap-4">
								<Progress value={detail.pct} className="h-2" />
								{detail.status === "ready" && (
									<p className="text-sm text-muted-foreground">{m.reviewHint}</p>
								)}
								<div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
									{detail.items.map((it) => (
										<div key={it.id} className="rounded-md border p-3">
											<div className="flex items-center justify-between gap-2">
												<span className="truncate text-sm font-medium">
													{it.persona?.name ?? `#${it.id}`}
												</span>
												<Badge variant={statusVariant(it.status)}>
													{statusLabel(it.status, m)}
												</Badge>
											</div>
											{it.persona !== null && (
												<p className="mt-1 truncate text-xs text-muted-foreground">
													{[it.persona.region, it.persona.ageBand, it.persona.register]
														.filter(Boolean)
														.join(" · ")}
												</p>
											)}
											{it.error !== null && (
												<p className="mt-1 truncate text-xs text-destructive">{it.error}</p>
											)}
										</div>
									))}
								</div>
								{detail.items.some((it) => it.persona !== null) && (
									<div>
										<p className="mb-2 text-sm font-medium">{m.distribution}</p>
										<div className="grid gap-3 sm:grid-cols-2">
											{distribution(detail).map(({ axis, entries }) =>
												entries.length === 0 ? null : (
													<div key={axis}>
														<p className="mb-1 text-xs uppercase text-muted-foreground">{axis}</p>
														{entries.map(({ k, c, pct }) => (
															<div key={k} className="mb-1 flex items-center gap-2">
																<span className="w-24 truncate text-xs">{k}</span>
																<div className="h-2 flex-1 rounded bg-muted">
																	<div
																		className="h-2 rounded bg-primary"
																		style={{ width: `${pct}%` }}
																	/>
																</div>
																<span className="w-6 text-right text-xs">{c}</span>
															</div>
														))}
													</div>
												),
											)}
										</div>
									</div>
								)}
							</CardContent>
						</Card>
					)}
				</TabsContent>

				<TabsContent value="endpoints">
					<div className="mb-4 flex justify-end">
						<Button onClick={() => openEndpoint({ ...ENDPOINT_EMPTY })}>
							<PlusIcon className="mr-1 size-4" />
							{m.newEndpoint}
						</Button>
					</div>
					{endpoints.length === 0 ? (
						<Empty>
							<EmptyHeader>
								<EmptyTitle>{m.endpointsTitle}</EmptyTitle>
								<EmptyDescription>{m.emptyEndpoints}</EmptyDescription>
							</EmptyHeader>
						</Empty>
					) : (
						<div className="grid gap-3">
							{endpoints.map((e) => (
								<Card key={e.id}>
									<CardContent className="flex items-center justify-between gap-4 py-4">
										<div className="min-w-0">
											<div className="flex items-center gap-2">
												<span className="font-medium">{e.name}</span>
												<Badge variant="outline">{e.kind}</Badge>
												{!e.enabled && <Badge variant="secondary">off</Badge>}
											</div>
											<p className="mt-1 truncate text-sm text-muted-foreground">
												{e.baseUrl}
												{e.model !== null ? ` · ${e.model}` : ""}
											</p>
											{testResult[e.id] !== undefined && (
												<p className="mt-1 text-xs text-muted-foreground">{testResult[e.id]}</p>
											)}
										</div>
										<div className="flex shrink-0 gap-2">
											<Button variant="outline" size="sm" onClick={() => void test(e.id)}>
												{m.test}
											</Button>
											<Button
												variant="outline"
												size="sm"
												onClick={() => openEndpoint(endpointFromCard(e))}
											>
												<PencilIcon className="mr-1 size-3" />
												{m.edit}
											</Button>
											{confirm?.kind === "endpoint" && confirm.id === e.id ? (
												<Button
													variant="destructive"
													size="sm"
													disabled={busy}
													onClick={() => void remove()}
												>
													{m.confirmDelete}
												</Button>
											) : (
												<Button
													variant="outline"
													size="sm"
													disabled={busy}
													onClick={() => setConfirm({ kind: "endpoint", id: e.id })}
												>
													<Trash2Icon className="size-3" />
												</Button>
											)}
										</div>
									</CardContent>
								</Card>
							))}
						</div>
					)}
				</TabsContent>
			</Tabs>

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m.newInstance}</DialogTitle>
					</DialogHeader>
					{form !== null && (
						<div className="grid gap-3">
							<Field>
								<FieldLabel>{m.name}</FieldLabel>
								<Input
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
								/>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel>{m.mode}</FieldLabel>
									<Select
										value={form.mode}
										onValueChange={(v) =>
											setForm({ ...form, mode: v === "selected" ? "selected" : "random" })
										}
									>
										<SelectTrigger aria-label={m.mode}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="selected">{m.modeSelected}</SelectItem>
											<SelectItem value="random">{m.modeRandom}</SelectItem>
										</SelectContent>
									</Select>
								</Field>
								<Field>
									<FieldLabel>{m.endpoint}</FieldLabel>
									<Select
										value={form.endpointId}
										onValueChange={(v) => setForm({ ...form, endpointId: String(v) })}
									>
										<SelectTrigger aria-label={m.endpoint}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={TEMPLATE}>{m.endpointTemplate}</SelectItem>
											{endpoints
												.filter((e) => e.enabled)
												.map((e) => (
													<SelectItem key={e.id} value={String(e.id)}>
														{e.name} · {e.model ?? e.kind}
													</SelectItem>
												))}
										</SelectContent>
									</Select>
								</Field>
							</div>
							{form.mode === "random" ? (
								<div className="grid grid-cols-3 gap-3">
									<Field>
										<FieldLabel>{m.count}</FieldLabel>
										<Input
											type="number"
											min={1}
											value={form.count}
											onChange={(e) => setForm({ ...form, count: e.target.value })}
										/>
									</Field>
									<Field>
										<FieldLabel>{m.seed}</FieldLabel>
										<Input
											type="number"
											value={form.seed}
											onChange={(e) => setForm({ ...form, seed: e.target.value })}
										/>
									</Field>
									<Field>
										<FieldLabel>{m.minutes}</FieldLabel>
										<Input
											type="number"
											min={1}
											value={form.minutes}
											onChange={(e) => setForm({ ...form, minutes: e.target.value })}
										/>
									</Field>
								</div>
							) : (
								<Field>
									<FieldLabel>{m.modeSelected}</FieldLabel>
									<div className="max-h-48 overflow-y-auto rounded-md border p-2">
										{defs.map((d) => (
											<label key={d.id} className="flex items-center gap-2 py-1 text-sm">
												<Checkbox
													checked={form.defIds.has(d.id)}
													onCheckedChange={(checked) => {
														const next = new Set(form.defIds);
														if (checked === true) next.add(d.id);
														else next.delete(d.id);
														setForm({ ...form, defIds: next });
													}}
												/>
												{d.name}
											</label>
										))}
									</div>
								</Field>
							)}
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setForm(null)}>
							{m.cancel}
						</Button>
						<Button
							disabled={
								busy ||
								form === null ||
								form.name === "" ||
								(form.mode === "selected" && form.defIds.size === 0)
							}
							onClick={() => void create()}
						>
							{m.create}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={spawnForm !== null} onOpenChange={(open) => !open && setSpawnForm(null)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m.spawnGenerators}</DialogTitle>
					</DialogHeader>
					{spawnForm !== null && (
						<div className="grid gap-3">
							<p className="text-xs text-muted-foreground">{m.spawnHint}</p>
							<Field>
								<FieldLabel>{m.generators}</FieldLabel>
								<div className="flex gap-2">
									{SPAWN_COUNTS.map((n) => (
										<Button
											key={n}
											size="sm"
											variant={spawnForm.count === n ? "default" : "outline"}
											onClick={() => setSpawnForm({ ...spawnForm, count: n })}
										>
											{n}
										</Button>
									))}
								</div>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel>{m.endpoint}</FieldLabel>
									<Select
										value={spawnForm.endpointId}
										onValueChange={(v) => setSpawnForm({ ...spawnForm, endpointId: String(v) })}
									>
										<SelectTrigger aria-label={m.endpoint}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={TEMPLATE}>{m.endpointTemplate}</SelectItem>
											{endpoints
												.filter((e) => e.enabled)
												.map((e) => (
													<SelectItem key={e.id} value={String(e.id)}>
														{e.name} · {e.model ?? e.kind}
													</SelectItem>
												))}
										</SelectContent>
									</Select>
								</Field>
								<Field>
									<FieldLabel>{m.perGenerator}</FieldLabel>
									<Input
										type="number"
										min={1}
										value={spawnForm.defCount}
										onChange={(e) => setSpawnForm({ ...spawnForm, defCount: e.target.value })}
									/>
								</Field>
							</div>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setSpawnForm(null)}>
							{m.cancel}
						</Button>
						<Button
							disabled={busy || spawnForm === null || spawnForm.defCount === ""}
							onClick={() => void spawn()}
						>
							{m.start}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={epForm !== null} onOpenChange={(open) => !open && setEpForm(null)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{epForm?.id !== null && epForm?.id !== undefined ? m.edit : m.newEndpoint}
						</DialogTitle>
					</DialogHeader>
					{epForm !== null && (
						<div className="grid gap-3">
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel>{m.name}</FieldLabel>
									<Input
										value={epForm.name}
										onChange={(e) => setEpForm({ ...epForm, name: e.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel>{m.kind}</FieldLabel>
									<Select
										value={epForm.kind}
										onValueChange={(v) => setEpForm({ ...epForm, kind: String(v) })}
									>
										<SelectTrigger aria-label={m.kind}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value="openai">openai-compat</SelectItem>
											<SelectItem value="acp">acp</SelectItem>
										</SelectContent>
									</Select>
								</Field>
							</div>
							{epForm.kind === "acp" && (
								<>
									<p className="text-xs text-muted-foreground">{m.acpHint}</p>
									<Field>
										<FieldLabel>{m.transport}</FieldLabel>
										<Select
											value={epForm.transport}
											onValueChange={(v) => setEpForm({ ...epForm, transport: String(v) })}
										>
											<SelectTrigger aria-label={m.transport}>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="ws">ws</SelectItem>
												<SelectItem value="child">child</SelectItem>
												<SelectItem value="ssh">ssh</SelectItem>
											</SelectContent>
										</Select>
										<p className="mt-1 text-xs text-muted-foreground">{m.transportHint}</p>
									</Field>
								</>
							)}
							<Field>
								{!epForm.id && (
									<div className="col-span-2 flex flex-wrap gap-2 pb-1">
										{[
											...ENDPOINT_PRESETS,
											...remotePresets.map((p) => ({
												label: p.label,
												form: {
													kind: p.kind,
													baseUrl: p.baseUrl,
													model: p.model ?? "",
													name: p.label,
												},
											})),
										].map((p) => (
											<Button
												key={p.label}
												size="sm"
												variant="ghost"
												className="h-6 border px-2 text-xs"
												onClick={() => setEpForm({ ...ENDPOINT_EMPTY, ...p.form })}
											>
												{p.label}
											</Button>
										))}
									</div>
								)}
								<FieldLabel>{m.baseUrl}</FieldLabel>
								<Input
									value={epForm.baseUrl}
									onChange={(e) => setEpForm({ ...epForm, baseUrl: e.target.value })}
								/>
							</Field>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel>{m.model}</FieldLabel>
									<Input
										value={epForm.model}
										onChange={(e) => setEpForm({ ...epForm, model: e.target.value })}
										placeholder="qwen2.5:7b-instruct-q4_K_M"
									/>
								</Field>
								<Field>
									<FieldLabel>{m.timeoutMs}</FieldLabel>
									<Input
										type="number"
										value={epForm.timeoutMs}
										onChange={(e) => setEpForm({ ...epForm, timeoutMs: e.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel>{m.sessionId}</FieldLabel>
									<Input
										value={epForm.sessionId}
										onChange={(e) => setEpForm({ ...epForm, sessionId: e.target.value })}
									/>
								</Field>
								<Field>
									<FieldLabel>{m.secretRef}</FieldLabel>
									<Select
										value={secretCustom ? SECRET_CUSTOM : secretSelectValue(epForm.secretRef)}
										onValueChange={(v) => {
											// Radix re-fires with null when the item holding the
											// previous value unmounts (stale credential option).
											if (v === null) return;
											const s = String(v);
											if (s === SECRET_CUSTOM) {
												setSecretCustom(true);
												setEpForm({
													...epForm,
													secretRef: epForm.secretRef.startsWith("credential:")
														? ""
														: epForm.secretRef,
												});
												return;
											}
											setSecretCustom(false);
											setEpForm({
												...epForm,
												secretRef: s === SECRET_NONE ? "" : s,
											});
										}}
									>
										<SelectTrigger aria-label={m.secretRef}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											<SelectItem value={SECRET_NONE}>{m.secretRefNone}</SelectItem>
											{creds.map((c) => (
												<SelectItem key={c.id} value={`credential:${c.id}`}>
													{c.name} · {c.provider} · {c.masked}
												</SelectItem>
											))}
											{epForm.secretRef.startsWith("credential:") &&
												!creds.some((c) => `credential:${c.id}` === epForm.secretRef) && (
													<SelectItem value={epForm.secretRef}>{epForm.secretRef}</SelectItem>
												)}
											<SelectItem value={SECRET_CUSTOM}>{m.secretRefCustom}</SelectItem>
										</SelectContent>
									</Select>
									{(secretCustom || secretSelectValue(epForm.secretRef) === SECRET_CUSTOM) && (
										<>
											<Input
												className="mt-1"
												value={epForm.secretRef}
												onChange={(e) => setEpForm({ ...epForm, secretRef: e.target.value })}
												placeholder="OLLAMA_API_KEY"
											/>
											<p className="mt-1 text-xs text-muted-foreground">{m.secretRefHint}</p>
										</>
									)}
								</Field>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={epForm.enabled}
									onCheckedChange={(c) => setEpForm({ ...epForm, enabled: c === true })}
								/>
								{m.enabled}
							</label>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setEpForm(null)}>
							{m.cancel}
						</Button>
						<Button
							disabled={busy || epForm === null || epForm.name === "" || epForm.baseUrl === ""}
							onClick={() => void saveEndpoint()}
						>
							{m.save}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageContainer>
	);
}
