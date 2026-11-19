import { useState } from "react";

import { ConfirmAction, TablePage, viewsMessages, type Column } from "@ktb/views/table";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Input } from "@ktbhealth/ui/components/input";

import type { PromptsApi } from "../apis.ts";
import { aiPromptMessages } from "../i18n.ts";
import type { PromptCard } from "../prompts.ts";

type Draft = {
	readonly id: number | null;
	readonly name: string;
	readonly version: string;
	readonly locale: string;
	readonly template: string;
	readonly modelHint: string;
	readonly isSystem: boolean;
	readonly isDefault: boolean;
	readonly enabled: boolean;
};

const emptyDraft: Draft = {
	id: null,
	name: "",
	version: "",
	locale: "",
	template: "",
	modelHint: "",
	isSystem: false,
	isDefault: false,
	enabled: true,
};

const draftFrom = (p: PromptCard): Draft => ({
	id: p.id,
	name: p.name,
	version: String(p.version),
	locale: p.locale,
	template: p.template,
	modelHint: p.modelHint ?? "",
	isSystem: p.isSystem,
	isDefault: p.isDefault,
	enabled: p.enabled,
});

/** /platform/ai/prompts view: versioned prompt registry — create
 * appends a new version (history is never mutated); edit fixes the
 * selected version's mutable fields.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage`
 * shell + `Column` model + `ConfirmAction` for the delete step. The
 * create/edit/new-version dialog stays plugin-local — it mixes a
 * textarea, checkboxes and prefilled drafts that the kit's
 * `FormDialog` cannot express. Mutations go through the injected
 * `PromptsApi` and update local state (no router invalidation —
 * unchanged from before). */
export function PromptsPage({
	prompts: initial,
	api,
	locale,
}: {
	prompts: readonly PromptCard[];
	api: PromptsApi;
	locale: string;
}) {
	const m = aiPromptMessages(locale);
	const [prompts, setPrompts] = useState<readonly PromptCard[]>(initial);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const save = async () => {
		/* v8 ignore next -- the Save button only renders while draft is set */
		if (draft === null) return;
		setBusy(true);
		setError(null);
		let r: { readonly ok: boolean; readonly data?: PromptCard };
		if (draft.id === null) {
			r = await api.create({
				name: draft.name,
				template: draft.template,
				...(draft.version !== "" ? { version: Number(draft.version) } : {}),
				...(draft.locale !== "" ? { locale: draft.locale } : {}),
				...(draft.modelHint !== "" ? { modelHint: draft.modelHint } : {}),
				isSystem: draft.isSystem,
				isDefault: draft.isDefault,
			});
		} else {
			r = await api.update({
				id: draft.id,
				template: draft.template,
				...(draft.modelHint !== "" ? { modelHint: draft.modelHint } : {}),
				isSystem: draft.isSystem,
				isDefault: draft.isDefault,
				enabled: draft.enabled,
			});
		}
		setBusy(false);
		setDraft(null);
		if (r.ok === true && r.data !== undefined) {
			setPrompts((prev) => {
				const next = prev.filter((x) => x.id !== r.data!.id);
				return [...next, r.data!].sort(
					(a, b) => a.name.localeCompare(b.name) || b.version - a.version,
				);
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
		if (r.ok) {
			setPrompts((prev) => prev.filter((x) => x.id !== id));
		} else {
			setError(m.actionFailed);
		}
	};

	const columns: Column<PromptCard>[] = [
		{
			key: "name",
			header: m.name,
			render: (p) => <span className="font-medium">{p.name}</span>,
		},
		{
			key: "version",
			header: m.version,
			render: (p) => `v${p.version}`,
		},
		{
			key: "locale",
			header: m.locale,
			render: (p) => (p.locale === "" ? "—" : p.locale),
		},
		{
			key: "isSystem",
			header: m.isSystem,
			render: (p) => (p.isSystem ? "✓" : ""),
		},
		{
			key: "isDefault",
			header: m.isDefault,
			render: (p) => (p.isDefault ? "★" : ""),
		},
		{
			key: "enabled",
			header: m.enabled,
			render: (p) => (p.enabled ? "✓" : "—"),
		},
		{
			key: "actions",
			header: "",
			render: (p) => (
				<div className="flex gap-2">
					<Button variant="outline" size="sm" onClick={() => setDraft(draftFrom(p))}>
						{m.edit}
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={() =>
							setDraft({
								...emptyDraft,
								name: p.name,
								locale: p.locale,
								isSystem: p.isSystem,
							})
						}
					>
						{m.newVersion}
					</Button>
					<ConfirmAction
						trigger={(open) => (
							<Button variant="outline" size="sm" onClick={open}>
								{m.delete}
							</Button>
						)}
						title={m.delete}
						description={m.confirmDelete}
						confirmLabel={m.delete}
						onConfirm={() => remove(p.id)}
					/>
				</div>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={m.title}
				description={m.subtitle}
				actions={<Button onClick={() => setDraft(emptyDraft)}>{m.add}</Button>}
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<TablePage.Table columns={columns} rows={prompts} empty={{ title: m.empty }} />

			<Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{draft?.id === null ? m.add : `${m.edit} — v${draft?.version ?? ""}`}
						</DialogTitle>
						<DialogDescription>{m.templateHint}</DialogDescription>
					</DialogHeader>
					{draft !== null && (
						<div className="grid grid-cols-2 gap-3">
							{draft.id === null && (
								<>
									<label className="text-sm">
										{m.name}
										<Input
											value={draft.name}
											onChange={(e) => setDraft({ ...draft, name: e.target.value })}
											placeholder="anamnesis.extract"
										/>
									</label>
									<label className="text-sm">
										{m.version}
										<Input
											value={draft.version}
											onChange={(e) => setDraft({ ...draft, version: e.target.value })}
											placeholder="auto"
										/>
									</label>
									<label className="text-sm">
										{m.locale}
										<Input
											value={draft.locale}
											onChange={(e) => setDraft({ ...draft, locale: e.target.value })}
											placeholder="pt-BR"
										/>
									</label>
								</>
							)}
							<label className="col-span-2 text-sm">
								{m.template}
								<textarea
									className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
									rows={8}
									value={draft.template}
									onChange={(e) => setDraft({ ...draft, template: e.target.value })}
								/>
							</label>
							<label className="text-sm">
								{m.modelHint}
								<Input
									value={draft.modelHint}
									onChange={(e) => setDraft({ ...draft, modelHint: e.target.value })}
								/>
							</label>
							<label className="flex items-center gap-2 text-sm">
								<input
									type="checkbox"
									checked={draft.isSystem}
									onChange={(e) => setDraft({ ...draft, isSystem: e.target.checked })}
								/>
								{m.isSystem}
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
		</TablePage>
	);
}
