import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CopyIcon, PencilIcon, PlugZapIcon, PlusIcon, StarIcon, Trash2Icon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
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
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import { listCredentialsFn } from "@ktb/credentials/fns";
import type { CredentialCard } from "@ktb/credentials";
import type { LlmEndpointPreset } from "@ktb/eval-consultation";

import {
	createBridgeLinkFn,
	deleteEndpointFn,
	endpointBridgeStatusFn,
	listEndpointPresetsFn,
	listEndpointsFn,
	saveEndpointFn,
	setPlatformDefaultEndpointFn,
	testEndpointFn,
} from "../fns.ts";
import { machinesListFn } from "@ktb/machines/fns";
import type { MachineCard } from "@ktb/machines";
import { aiEndpointMessages } from "../i18n.ts";
import type { BridgeStatus, EndpointCard } from "../index.ts";

/** A bridge endpoint: acp+ws with no dialable URL — the agent lives
 * behind the local `ai-bridge` CLI (F3b). */
const isBridgeCard = (e: EndpointCard): boolean =>
	e.kind === "acp" && (e.transport ?? "ws") === "ws" && e.baseUrl === "";

const SECRET_NONE = "__none__";
const SECRET_CUSTOM = "__custom__";

// `secret_ref` holds either an env var NAME or `credential:<id>` —
// the select exposes the credential store, "custom" reveals the raw
// env-var input for the legacy path.
const secretSelectValue = (ref: string) =>
	ref === "" ? SECRET_NONE : ref.startsWith("credential:") ? ref : SECRET_CUSTOM;

type EndpointForm = {
	id: number | null;
	name: string;
	kind: string;
	baseUrl: string;
	model: string;
	sessionId: string;
	secretRef: string;
	transport: string;
	agentCmd: string;
	sshHost: string;
	machineId: string;
	scope: string;
	isDefault: boolean;
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
	agentCmd: "",
	sshHost: "",
	machineId: "",
	scope: "eval",
	isDefault: false,
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
	agentCmd: e.agentCmd ?? "",
	sshHost: e.sshHost ?? "",
	machineId: e.machineId !== null ? String(e.machineId) : "",
	scope: e.scope,
	isDefault: e.isDefault,
	timeoutMs: String(e.timeoutMs),
	enabled: e.enabled,
});

/** /platform/ai/endpoints view: CRUD of generative providers — the
 * endpoints every AI surface (eval lab today) binds through
 * `AiEndpoints.resolve`. */
export function EndpointsPage({
	endpoints: initial,
	locale,
}: {
	endpoints: readonly EndpointCard[];
	locale: string;
}) {
	const m = aiEndpointMessages(locale);
	const router = useRouter();
	const [endpoints, setEndpoints] = useState<readonly EndpointCard[]>(initial);
	const [epForm, setEpForm] = useState<EndpointForm | null>(null);
	const [creds, setCreds] = useState<readonly CredentialCard[]>([]);
	// Machine registry cards for the ACP "run on" picker — lazily loaded
	// with the dialog like the credentials above.
	const [machines, setMachines] = useState<readonly MachineCard[]>([]);
	// Provider starter endpoints declared by the bound adapter — fetched
	// lazily with the credentials so provider URLs never ship in the
	// plugin bundle (provider-lockin).
	const [remotePresets, setRemotePresets] = useState<readonly LlmEndpointPreset[]>([]);
	const [secretCustom, setSecretCustom] = useState(false);
	const [confirmId, setConfirmId] = useState<number | null>(null);
	const [testResult, setTestResult] = useState<Record<number, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Bridge connect dialog: the bearer command is minted on open and
	// lives only in this state — status polls while the dialog is up.
	const [bridge, setBridge] = useState<{
		readonly id: number;
		readonly command: string | null;
		readonly status: BridgeStatus | null;
	} | null>(null);
	const [copied, setCopied] = useState(false);

	const refresh = async () => {
		const e = await listEndpointsFn();
		/* v8 ignore next -- endpoint list failure keeps stale cards; next poll retries */
		if (e.ok) setEndpoints(e.data);
	};

	// Credentials + adapter presets load lazily — only the endpoint
	// dialog consumes them.
	const openEndpoint = (f: EndpointForm) => {
		setEpForm(f);
		setSecretCustom(false);
		void (async () => {
			const [c, p, mc] = await Promise.all([
				listCredentialsFn(),
				listEndpointPresetsFn(),
				// Best-effort: a machines failure just leaves the picker empty.
				machinesListFn().catch(() => [] as readonly MachineCard[]),
			]);
			if (c.ok) setCreds(c.data);
			if (p.ok) setRemotePresets(p.data);
			setMachines(mc);
		})();
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await deleteEndpointFn({ data: { id } });
		setBusy(false);
		setConfirmId(null);
		if (r.ok) {
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
				...(epForm.kind === "acp" && epForm.transport !== "ws" && epForm.agentCmd !== ""
					? { agentCmd: epForm.agentCmd }
					: {}),
				...(epForm.kind === "acp" && epForm.transport === "ssh" && epForm.sshHost !== ""
					? { sshHost: epForm.sshHost }
					: {}),
				...(epForm.machineId !== "" ? { machineId: Number(epForm.machineId) } : {}),
				...(epForm.scope !== "" ? { scope: epForm.scope } : {}),
				isDefault: epForm.isDefault,
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
		await refresh();
		void router.invalidate();
	};

	const setPlatformDefault = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await setPlatformDefaultEndpointFn({ data: { id } });
		setBusy(false);
		if (r.ok) {
			await refresh();
			void router.invalidate();
		} else {
			setError(m.actionFailed);
		}
	};

	/** Mint the link and open the connect dialog — the raw
	 * command exists only in component state, never re-fetchable. */
	const openBridge = async (id: number) => {
		setCopied(false);
		setBridge({ id, command: null, status: null });
		const r = await createBridgeLinkFn({ data: { id } });
		setBridge((prev) =>
			prev === null || prev.id !== id
				? prev
				: { ...prev, command: r.ok && r.data !== null ? r.data.command : "" },
		);
	};

	// Poll the bridge status while the dialog is open — the badge
	// flips to connected as soon as the CLI's socket lands on the DO.
	const bridgeId = bridge?.id;
	useEffect(() => {
		if (bridgeId === undefined) return;
		const id = bridgeId;
		let stopped = false;
		const tick = async () => {
			const r = await endpointBridgeStatusFn({ data: { id } });
			if (stopped) return;
			if (r.ok) {
				setBridge((prev) => {
					/* v8 ignore next -- the tick only runs while this id's dialog is open */
					if (prev === null || prev.id !== id) return prev;
					return { ...prev, status: r.data?.status ?? null };
				});
			}
		};
		void tick();
		const timer = setInterval(() => void tick(), 3_000);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [bridgeId]);

	const copyCommand = async () => {
		/* v8 ignore next -- the Copy button only renders with a non-empty command */
		if (bridge?.command == null || bridge.command === "") return;
		try {
			await navigator.clipboard.writeText(bridge.command);
		} catch {
			// Clipboard API unavailable (insecure context) — the command
			// stays selected in the read-only input for manual copy.
		}
		setCopied(true);
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
			<PageHeader title={m.endpointsTitle} description={m.endpointsDesc} />
			{error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}
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
										<Badge variant="outline">{e.scope}</Badge>
										{e.isDefault && <Badge variant="secondary">default</Badge>}
										{!e.enabled && <Badge variant="secondary">off</Badge>}
										{isBridgeCard(e) && <Badge variant="outline">{m.bridgeBadge}</Badge>}
									</div>
									<p className="mt-1 truncate text-sm text-muted-foreground">
										{e.baseUrl === "" ? m.bridgeBadge : e.baseUrl}
										{e.model !== null ? ` · ${e.model}` : ""}
									</p>
									{testResult[e.id] !== undefined && (
										<p className="mt-1 text-xs text-muted-foreground">{testResult[e.id]}</p>
									)}
								</div>
								<div className="flex shrink-0 gap-2">
									{isBridgeCard(e) && e.enabled && (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => void openBridge(e.id)}
										>
											<PlugZapIcon className="mr-1 size-3" />
											{m.bridgeConnect}
										</Button>
									)}
									{!(e.scope === "platform" && e.isDefault) && (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => void setPlatformDefault(e.id)}
										>
											<StarIcon className="mr-1 size-3" />
											{m.setPlatformDefault}
										</Button>
									)}
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
									{confirmId === e.id ? (
										<Button
											variant="destructive"
											size="sm"
											disabled={busy}
											onClick={() => void remove(e.id)}
										>
											{m.confirmDelete}
										</Button>
									) : (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => setConfirmId(e.id)}
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
									{epForm.transport !== "ws" && (
										<div className="grid grid-cols-2 gap-3">
											<Field>
												<FieldLabel>{m.agentCmd}</FieldLabel>
												<Input
													value={epForm.agentCmd}
													onChange={(e) => setEpForm({ ...epForm, agentCmd: e.target.value })}
													placeholder="claude-agent-acp"
												/>
												<p className="mt-1 text-xs text-muted-foreground">{m.agentCmdHint}</p>
											</Field>
											{epForm.transport === "ssh" && (
												<Field>
													<FieldLabel>{m.sshHost}</FieldLabel>
													<Input
														value={epForm.sshHost}
														onChange={(e) => setEpForm({ ...epForm, sshHost: e.target.value })}
														placeholder="user@host"
													/>
												</Field>
											)}
											<Field>
												<FieldLabel>{m.machine}</FieldLabel>
												<select
													className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
													value={epForm.machineId}
													onChange={(e) => setEpForm({ ...epForm, machineId: e.target.value })}
												>
													<option value="">—</option>
													{machines.map((mc) => (
														<option key={mc.id} value={mc.id}>
															{mc.name}
														</option>
													))}
												</select>
												<p className="mt-1 text-xs text-muted-foreground">{m.machineHint}</p>
											</Field>
										</div>
									)}
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
								{epForm.kind === "acp" && epForm.transport === "ws" && (
									<p className="mt-1 text-xs text-muted-foreground">{m.baseUrlBridgeHint}</p>
								)}
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
								<Field>
									<FieldLabel>{m.scopeLabel}</FieldLabel>
									<Input
										value={epForm.scope}
										onChange={(e) => setEpForm({ ...epForm, scope: e.target.value })}
									/>
								</Field>
							</div>
							<label className="flex items-center gap-2 text-sm">
								<Checkbox
									checked={epForm.isDefault}
									onCheckedChange={(c) => setEpForm({ ...epForm, isDefault: c === true })}
								/>
								{m.isDefaultLabel}
							</label>
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
							disabled={
								busy ||
								epForm === null ||
								epForm.name === "" ||
								// acp+ws tolerates an empty baseUrl — that IS the
								// bridge endpoint (the agent connects outbound
								// through the DO instead of being dialed).
								(epForm.baseUrl === "" && !(epForm.kind === "acp" && epForm.transport === "ws"))
							}
							onClick={() => void saveEndpoint()}
						>
							{m.save}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={bridge !== null} onOpenChange={(open) => !open && setBridge(null)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m.bridgeTitle}</DialogTitle>
					</DialogHeader>
					<div className="grid gap-3">
						<p className="text-sm text-muted-foreground">{m.bridgeDesc}</p>
						{bridge?.command != null && bridge.command !== "" && (
							<div className="flex gap-2">
								<Input readOnly value={bridge.command} aria-label={m.bridgeTitle} />
								<Button variant="outline" size="sm" onClick={() => void copyCommand()}>
									<CopyIcon className="mr-1 size-3" />
									{copied ? m.bridgeCopied : m.bridgeCopy}
								</Button>
							</div>
						)}
						<p className="text-sm" aria-live="polite">
							{bridge?.status === "connected"
								? m.bridgeConnected
								: bridge?.status === "offline"
									? m.bridgeOffline
									: m.bridgeWaiting}
						</p>
					</div>
					<DialogFooter>
						<Button variant="outline" onClick={() => setBridge(null)}>
							{m.bridgeClose}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageContainer>
	);
}
