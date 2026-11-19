import { useState } from "react";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { TablePage, viewsMessages, type Column } from "@ktb/views/table";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import { createCredentialFn, removeCredentialFn } from "../fns.ts";
import { credMessages, I18N_NAMESPACE } from "../i18n.ts";
import type { CredentialCard } from "../index.ts";

const PROVIDERS = ["openai", "anthropic", "gemini", "acp", "other"] as const;

/**
 * Credentials console view — platform-admin list of outbound provider
 * secrets (masked on the wire). Built on the shared table kit
 * (`@ktb/views/table`): `TablePage` shell + `Column` model. Mutations
 * stay on the plugin's server fns with a local `refresh()` (the page
 * owns its row state, so `useServerMutation`'s router invalidation
 * does not apply); the delete keeps its two-step inline confirm and
 * the create dialog keeps its provider Select + password field that
 * `FormDialog` cannot express.
 */
export function CredentialsPage({
	creds: initial,
	i18n,
	locale,
}: {
	creds: readonly CredentialCard[];
	i18n?: PageI18nSlice;
	locale: string;
}) {
	// PL-008 Phase 4: string copy resolves from the DB catalog slice
	// (ctx.i18n); the code catalog is the fallback until every
	// environment has re-run i18n:import-baseline.
	const m = sliceMessages(i18n, I18N_NAMESPACE, credMessages(locale));
	const [creds, setCreds] = useState(initial);
	const [form, setForm] = useState<{ name: string; provider: string; secret: string } | null>(null);
	const [confirmId, setConfirmId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		const { listCredentialsFn } = await import("../fns.ts");
		const r = await listCredentialsFn();
		/* v8 ignore next -- wire envelope */
		if (r.ok) setCreds(r.data);
	};

	const save = async () => {
		/* v8 ignore next -- dialog only renders when form is set */
		if (form === null) return;
		setBusy(true);
		const r = await createCredentialFn({
			data: { name: form.name, provider: form.provider, secret: form.secret },
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setForm(null);
		await refresh();
	};

	const remove = async (id: string) => {
		setBusy(true);
		const r = await removeCredentialFn({ data: { id } });
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setConfirmId(null);
		await refresh();
	};

	const columns: Column<CredentialCard>[] = [
		{
			key: "name",
			header: m.name,
			render: (c) => (
				<span className="flex items-center gap-2">
					<KeyRoundIcon className="size-4 text-muted-foreground" />
					<span className="font-medium">{c.name}</span>
					<span className="text-xs text-muted-foreground">{c.masked}</span>
				</span>
			),
		},
		{
			key: "provider",
			header: m.provider,
			render: (c) => <Badge variant="outline">{c.provider}</Badge>,
		},
	];

	const rowActions = (c: CredentialCard) =>
		confirmId === c.id ? (
			<Button
				type="button"
				size="sm"
				variant="destructive"
				disabled={busy}
				onClick={() => remove(c.id)}
			>
				{m.confirmDelete}
			</Button>
		) : (
			<Button
				type="button"
				size="icon-sm"
				variant="outline"
				aria-label={m.delete}
				onClick={() => setConfirmId(c.id)}
			>
				<Trash2Icon className="size-4" />
			</Button>
		);

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={m.title}
				description={m.desc}
				actions={
					<Button type="button" onClick={() => setForm({ name: "", provider: "openai", secret: "" })}>
						<PlusIcon className="mr-1 size-4" />
						{m.newCred}
					</Button>
				}
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<TablePage.Table
				columns={columns}
				rows={creds}
				rowKey={(c) => c.id}
				empty={{ title: m.empty }}
				locale={locale}
				rowActions={rowActions}
			/>
			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{m.newCred}</DialogTitle>
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
							<Field>
								<FieldLabel>{m.provider}</FieldLabel>
								<Select
									value={form.provider}
									onValueChange={(v) => setForm({ ...form, provider: String(v) })}
								>
									<SelectTrigger aria-label={m.provider}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{PROVIDERS.map((p) => (
											<SelectItem key={p} value={p}>
												{p}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</Field>
							<Field>
								<FieldLabel>{m.secret}</FieldLabel>
								<Input
									type="password"
									value={form.secret}
									onChange={(e) => setForm({ ...form, secret: e.target.value })}
								/>
							</Field>
							<div className="flex justify-end gap-2">
								<Button variant="outline" onClick={() => setForm(null)}>
									{m.cancel}
								</Button>
								<Button
									disabled={busy || form.name.trim() === "" || form.secret.trim() === ""}
									onClick={save}
								>
									{m.save}
								</Button>
							</div>
						</div>
					)}
				</DialogContent>
			</Dialog>
		</TablePage>
	);
}
