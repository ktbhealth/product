import { useState } from "react";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { createCatalogT } from "@ktb/i18n";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
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
import { credMessages, I18N_NAMESPACE, type CredMessages } from "../i18n.ts";
import type { CredentialCard } from "../index.ts";

const PROVIDERS = ["openai", "anthropic", "gemini", "acp", "other"] as const;

export function CredentialsPage({
	creds: initial,
	i18n,
	locale,
}: {
	creds: readonly CredentialCard[];
	i18n?: { readonly locale: string; readonly catalog: Readonly<Record<string, string>> };
	locale: string;
}) {
	// PL-008 Phase 4: copy resolves from the DB catalog slice (ctx.i18n)
	// when the host shipped one; the code catalog is the fallback until
	// every environment has re-run i18n:import-baseline.
	const t = i18n === undefined ? undefined : createCatalogT(i18n.catalog, i18n.locale);
	const legacy = credMessages(locale);
	const tt = (key: keyof CredMessages): string => {
		const full = `${I18N_NAMESPACE}.${key}`;
		const resolved = t?.(full);
		return resolved === undefined || resolved === full ? legacy[key] : resolved;
	};
	const m: CredMessages = {
		title: tt("title"),
		desc: tt("desc"),
		newCred: tt("newCred"),
		name: tt("name"),
		provider: tt("provider"),
		secret: tt("secret"),
		save: tt("save"),
		cancel: tt("cancel"),
		delete: tt("delete"),
		confirmDelete: tt("confirmDelete"),
		empty: tt("empty"),
		actionFailed: tt("actionFailed"),
	};
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

	return (
		<div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6">
			<div>
				<h1 className="font-heading text-2xl font-semibold tracking-tight">{m.title}</h1>
				<p className="text-sm text-muted-foreground">{m.desc}</p>
			</div>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<div className="flex justify-end">
				<Button onClick={() => setForm({ name: "", provider: "openai", secret: "" })}>
					<PlusIcon className="mr-1 size-4" />
					{m.newCred}
				</Button>
			</div>
			{creds.length === 0 ? (
				<p className="text-sm text-muted-foreground">{m.empty}</p>
			) : (
				<div className="grid gap-3">
					{creds.map((c) => (
						<Card key={c.id} size="sm">
							<CardContent className="flex items-center justify-between py-3">
								<div className="flex items-center gap-2">
									<KeyRoundIcon className="size-4 text-muted-foreground" />
									<span className="font-medium">{c.name}</span>
									<Badge variant="outline">{c.provider}</Badge>
									<span className="text-xs text-muted-foreground">{c.masked}</span>
								</div>
								{confirmId === c.id ? (
									<Button
										size="sm"
										variant="destructive"
										disabled={busy}
										onClick={() => remove(c.id)}
									>
										{m.confirmDelete}
									</Button>
								) : (
									<Button
										size="icon-sm"
										variant="outline"
										aria-label={m.delete}
										onClick={() => setConfirmId(c.id)}
									>
										<Trash2Icon className="size-4" />
									</Button>
								)}
							</CardContent>
						</Card>
					))}
				</div>
			)}
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
		</div>
	);
}
