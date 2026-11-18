import { useState } from "react";

import { Button } from "@ktbhealth/ui/components/button";
import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import type { ModelsApi } from "../apis.ts";
import { aiModelMessages } from "../i18n.ts";
import type { ModelCard } from "../models.ts";
import type { AiModelKind } from "../schema.ts";

const KINDS: readonly AiModelKind[] = ["chat", "vision", "asr", "tts", "judge", "embed", "other"];

const KIND_TONE: Record<AiModelKind, string> = {
	chat: "",
	vision: "",
	asr: "",
	tts: "",
	judge: "",
	embed: "",
	other: "text-muted-foreground",
};

type Draft = {
	readonly id: number | null;
	readonly name: string;
	readonly modelId: string;
	readonly endpointId: string;
	readonly kind: AiModelKind;
	readonly capabilities: string;
	readonly contextTokens: string;
	readonly costTier: string;
	readonly isDefault: boolean;
	readonly enabled: boolean;
};

const emptyDraft: Draft = {
	id: null,
	name: "",
	modelId: "",
	endpointId: "",
	kind: "chat",
	capabilities: "",
	contextTokens: "",
	costTier: "",
	isDefault: false,
	enabled: true,
};

const draftFrom = (m: ModelCard): Draft => ({
	id: m.id,
	name: m.name,
	modelId: m.modelId,
	endpointId: m.endpointId !== null ? String(m.endpointId) : "",
	kind: m.kind,
	capabilities: m.capabilities.join(", "),
	contextTokens: m.contextTokens !== null ? String(m.contextTokens) : "",
	costTier: m.costTier ?? "",
	isDefault: m.isDefault,
	enabled: m.enabled,
});

const parseCaps = (raw: string): readonly string[] =>
	raw
		.split(",")
		.map((c) => c.trim())
		.filter((c) => c !== "");

/** /platform/ai/models view: CRUD of the AI model catalog — the
 * registry LLM factories, eval judges and transcription adapters
 * resolve through `AiModels.resolve`. */
export function ModelsPage({
	models: initial,
	api,
	locale,
}: {
	models: readonly ModelCard[];
	api: ModelsApi;
	locale: string;
}) {
	const m = aiModelMessages(locale);
	const [models, setModels] = useState<readonly ModelCard[]>(initial);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [confirmId, setConfirmId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		/* v8 ignore next -- the Save button only renders while draft is set */
		if (draft === null) return;
		setBusy(true);
		setError(null);
		const caps = parseCaps(draft.capabilities);
		const payload = {
			name: draft.name,
			modelId: draft.modelId,
			...(draft.endpointId !== "" ? { endpointId: Number(draft.endpointId) } : {}),
			kind: draft.kind,
			...(caps.length > 0 ? { capabilities: caps } : {}),
			...(draft.contextTokens !== "" ? { contextTokens: Number(draft.contextTokens) } : {}),
			...(draft.costTier !== "" ? { costTier: draft.costTier } : {}),
			isDefault: draft.isDefault,
		};
		const r =
			draft.id === null
				? await api.create(payload)
				: await api.update({
						id: draft.id,
						...payload,
						enabled: draft.enabled,
					});
		setBusy(false);
		setDraft(null);
		if (r.ok === true && r.data !== undefined) {
			setModels((prev) => {
				const next = prev.filter((x) => x.id !== r.data!.id);
				return [...next, r.data!].sort((a, b) => a.name.localeCompare(b.name));
			});
		} else {
			setError(m.actionFailed);
		}
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await api.remove(id);
		setBusy(false);
		setConfirmId(null);
		if (r.ok) {
			setModels((prev) => prev.filter((x) => x.id !== id));
		} else {
			setError(m.actionFailed);
		}
	};

	return (
		<div className="space-y-4 p-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">{m.title}</h1>
					<p className="text-sm text-muted-foreground">{m.subtitle}</p>
				</div>
				<Button onClick={() => setDraft(emptyDraft)}>{m.add}</Button>
			</div>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			{models.length === 0 ? (
				<p className="text-sm text-muted-foreground">{m.empty}</p>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.name}</TableHead>
							<TableHead>{m.modelId}</TableHead>
							<TableHead>{m.kind}</TableHead>
							<TableHead>{m.endpointId}</TableHead>
							<TableHead>{m.isDefault}</TableHead>
							<TableHead>{m.enabled}</TableHead>
							<TableHead />
						</TableRow>
					</TableHeader>
					<TableBody>
						{models.map((model) => (
							<TableRow key={model.id}>
								<TableCell className="font-medium">{model.name}</TableCell>
								<TableCell className="font-mono text-xs">{model.modelId}</TableCell>
								<TableCell className={KIND_TONE[model.kind]}>{model.kind}</TableCell>
								<TableCell>{model.endpointId ?? "—"}</TableCell>
								<TableCell>{model.isDefault ? "★" : ""}</TableCell>
								<TableCell>{model.enabled ? "✓" : "—"}</TableCell>
								<TableCell className="flex gap-2">
									<Button variant="outline" size="sm" onClick={() => setDraft(draftFrom(model))}>
										{m.edit}
									</Button>
									<Button variant="outline" size="sm" onClick={() => setConfirmId(model.id)}>
										{m.delete}
									</Button>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}

			<Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{draft?.id === null ? m.add : m.edit}</DialogTitle>
						<DialogDescription>{m.kindHint}</DialogDescription>
					</DialogHeader>
					{draft !== null && (
						<div className="grid grid-cols-2 gap-3">
							<label className="text-sm">
								{m.name}
								<Input
									value={draft.name}
									onChange={(e) => setDraft({ ...draft, name: e.target.value })}
								/>
							</label>
							<label className="text-sm">
								{m.modelId}
								<Input
									value={draft.modelId}
									onChange={(e) => setDraft({ ...draft, modelId: e.target.value })}
									placeholder="qwen2.5:7b-instruct"
								/>
							</label>
							<label className="text-sm">
								{m.endpointId}
								<Input
									value={draft.endpointId}
									onChange={(e) => setDraft({ ...draft, endpointId: e.target.value })}
									placeholder="—"
								/>
							</label>
							<label className="text-sm">
								{m.kind}
								<Select
									items={KINDS.map((k) => ({ value: k, label: k }))}
									value={draft.kind}
									onValueChange={(v) => setDraft({ ...draft, kind: v as AiModelKind })}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{KINDS.map((k) => (
											<SelectItem key={k} value={k}>
												{k}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</label>
							<label className="text-sm">
								{m.capabilities}
								<Input
									value={draft.capabilities}
									onChange={(e) => setDraft({ ...draft, capabilities: e.target.value })}
									placeholder="chat, vision"
								/>
							</label>
							<label className="text-sm">
								{m.contextTokens}
								<Input
									value={draft.contextTokens}
									onChange={(e) => setDraft({ ...draft, contextTokens: e.target.value })}
								/>
							</label>
							<label className="text-sm">
								{m.costTier}
								<Input
									value={draft.costTier}
									onChange={(e) => setDraft({ ...draft, costTier: e.target.value })}
									placeholder="low"
								/>
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={draft.isDefault}
									onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })}
								/>
								{m.isDefault}
							</label>
							{draft.id !== null && (
								<label className="flex items-center gap-2 text-sm">
									<input
										type="checkbox"
										checked={draft.enabled}
										onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
									/>
									{m.enabled}
								</label>
							)}
							<div className="col-span-2 flex gap-2">
								<Button onClick={() => void save()} disabled={busy}>
									{m.save}
								</Button>
								<Button variant="outline" onClick={() => setDraft(null)}>
									{m.cancel}
								</Button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={confirmId !== null}
				onOpenChange={(open) => !open && setConfirmId(null)}
				title={m.delete}
				description={m.confirmDelete}
				confirmLabel={m.delete}
				onConfirm={() => {
					/* v8 ignore next -- onConfirm only fires while the dialog is open */
					if (confirmId !== null) void remove(confirmId);
				}}
			/>
		</div>
	);
}
