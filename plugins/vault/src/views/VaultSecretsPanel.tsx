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

import { LocalDateTime } from "@ktb/views/views";

import type { SecretMeta } from "../secrets.ts";
import type { VaultSecretKind } from "../schema.ts";
import { vaultMessages } from "../i18n.ts";

/** Mutation surface for the secrets panel — bound to the plugin's
 * server fns by ./apis.ts, mocked in tests. Values are write-only:
 * `put` is the ONLY call that carries plaintext. */
export interface VaultSecretsApi {
	readonly put: (input: {
		readonly name: string;
		readonly value: string;
		readonly provider?: string | null;
		readonly kind?: VaultSecretKind;
	}) => Promise<{ readonly ok: boolean; readonly data?: SecretMeta }>;
	readonly rotate: (id: number) => Promise<{ readonly ok: boolean }>;
	readonly remove: (id: number) => Promise<{ readonly ok: boolean }>;
}

const KINDS: readonly VaultSecretKind[] = ["api-key", "token", "password", "pem", "generic"];

/**
 * Server-side secrets manager (P-098 C2): lists SecretMeta rows for
 * the bound tenant — names/providers/versions only, never values.
 * Mutations (add = upsert by name, rotate, delete) render for tenant
 * admins; the service re-checks the role server-side regardless.
 */
export function VaultSecretsPanel({
	secrets,
	canManage,
	api,
	locale = "en",
	onChanged,
}: {
	readonly secrets: readonly SecretMeta[];
	readonly canManage: boolean;
	readonly api: VaultSecretsApi;
	readonly locale?: string;
	readonly onChanged: () => void;
}) {
	const t = vaultMessages(locale);
	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const [adding, setAdding] = useState(false);
	const [rotating, setRotating] = useState<SecretMeta | null>(null);
	const [removingSecret, setRemovingSecret] = useState<SecretMeta | null>(null);
	const [form, setForm] = useState({
		name: "",
		provider: "",
		kind: "generic" as VaultSecretKind,
		value: "",
	});

	const run = async (fn: () => Promise<{ readonly ok: boolean }>) => {
		setError(false);
		setBusy(true);
		try {
			const res = await fn();
			if (!res.ok) {
				setError(true);
				return;
			}
			onChanged();
		} finally {
			setBusy(false);
		}
	};

	const submitAdd = () =>
		run(async () => {
			const res = await api.put({
				name: form.name.trim(),
				value: form.value,
				provider: form.provider.trim() === "" ? null : form.provider.trim(),
				kind: form.kind,
			});
			if (res.ok) {
				setAdding(false);
				setForm({ name: "", provider: "", kind: "generic", value: "" });
			}
			return res;
		});

	return (
		<div className="rounded-lg border border-border p-4">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h3 className="text-sm font-medium">{t.secretsTitle}</h3>
					<p className="mt-1 text-sm text-muted-foreground">{t.secretsDescription}</p>
				</div>
				{canManage ? (
					<Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={busy}>
						{t.secretsAdd}
					</Button>
				) : null}
			</div>

			{error ? <p className="mt-3 text-sm text-destructive">{t.actionFailed}</p> : null}

			<div className="mt-4">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{t.colSecret}</TableHead>
							<TableHead>{t.secretProvider}</TableHead>
							<TableHead>{t.secretKind}</TableHead>
							<TableHead>{t.colVersion}</TableHead>
							<TableHead>{t.colCreated}</TableHead>
							{canManage ? <TableHead className="text-right">{t.colActions}</TableHead> : null}
						</TableRow>
					</TableHeader>
					<TableBody>
						{secrets.length === 0 ? (
							<TableRow>
								<TableCell colSpan={canManage ? 6 : 5} className="text-muted-foreground">
									{t.secretsEmpty}
								</TableCell>
							</TableRow>
						) : (
							secrets.map((secret) => (
								<TableRow key={secret.id}>
									<TableCell className="font-medium">{secret.name}</TableCell>
									<TableCell>{secret.provider ?? "—"}</TableCell>
									<TableCell>{secret.kind}</TableCell>
									<TableCell>{secret.version}</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										<LocalDateTime
											value={secret.updatedAt ?? secret.createdAt}
											locale={locale}
											fallback="—"
										/>
									</TableCell>
									{canManage ? (
										<TableCell className="text-right">
											<Button
												size="sm"
												variant="outline"
												onClick={() => setRotating(secret)}
												disabled={busy}
											>
												{t.secretRotate}
											</Button>
											<Button
												size="sm"
												variant="outline"
												onClick={() => setRemovingSecret(secret)}
												disabled={busy}
											>
												{t.secretRemove}
											</Button>
										</TableCell>
									) : null}
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>

			<Dialog open={adding} onOpenChange={(open) => !open && setAdding(false)}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t.secretsAdd}</DialogTitle>
						<DialogDescription>{t.secretsDescription}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<Input
							value={form.name}
							onChange={(e) => setForm({ ...form, name: e.target.value })}
							placeholder={t.secretName}
							aria-label={t.secretName}
						/>
						<Input
							value={form.provider}
							onChange={(e) => setForm({ ...form, provider: e.target.value })}
							placeholder={t.secretProvider}
							aria-label={t.secretProvider}
						/>
						<Select
							items={KINDS.map((kind) => ({ value: kind, label: kind }))}
							value={form.kind}
							onValueChange={(v) => setForm({ ...form, kind: v as VaultSecretKind })}
						>
							<SelectTrigger aria-label={t.secretKind} className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{KINDS.map((kind) => (
									<SelectItem key={kind} value={kind}>
										{kind}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input
							type="password"
							value={form.value}
							onChange={(e) => setForm({ ...form, value: e.target.value })}
							placeholder={t.secretValue}
							aria-label={t.secretValue}
							autoComplete="off"
						/>
						<p className="text-xs text-muted-foreground">{t.secretValueHint}</p>
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => setAdding(false)} disabled={busy}>
								{t.cancel}
							</Button>
							<Button
								onClick={() => void submitAdd()}
								disabled={busy || form.name.trim() === "" || form.value === ""}
							>
								{t.secretsAdd}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={rotating !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- only close events fire; open is controlled */
					if (!open) setRotating(null);
				}}
				title={t.secretRotateTitle}
				description={t.secretRotateDescription(rotating?.name ?? "")}
				confirmLabel={t.secretRotate}
				cancelLabel={t.cancel}
				loading={busy}
				onConfirm={() =>
					void run(async () => {
						/* v8 ignore next -- confirm only fires while the dialog is open */
						if (rotating === null) return { ok: false };
						const res = await api.rotate(rotating.id);
						if (res.ok) setRotating(null);
						return res;
					})
				}
			/>
			<ConfirmDialog
				open={removingSecret !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- only close events fire; open is controlled */
					if (!open) setRemovingSecret(null);
				}}
				title={t.secretRemoveTitle}
				description={t.secretRemoveDescription(removingSecret?.name ?? "")}
				confirmLabel={t.secretRemove}
				cancelLabel={t.cancel}
				variant="destructive"
				loading={busy}
				onConfirm={() =>
					void run(async () => {
						/* v8 ignore next -- confirm only fires while the dialog is open */
						if (removingSecret === null) return { ok: false };
						const res = await api.remove(removingSecret.id);
						if (res.ok) setRemovingSecret(null);
						return res;
					})
				}
			/>
		</div>
	);
}
