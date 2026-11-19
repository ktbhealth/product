import { useState } from "react";

import {
	ConfirmAction,
	TablePage,
	viewsMessages,
	type Column,
} from "@ktb/views/table";

import { Button } from "@ktbhealth/ui/components/button";
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

import { LocalDateTime } from "@ktb/views/views";

import type { MachinesApi } from "../apis.ts";
import { machineMessages } from "../i18n.ts";
import type { MachineCard } from "../machines.ts";
import type { MachineKind, MachineStatus } from "../schema.ts";

const KINDS: readonly MachineKind[] = ["shell", "vm", "gpu", "endpoint", "other"];

const STATUS_TONE: Record<MachineStatus, string> = {
	online: "text-success",
	offline: "text-destructive",
	draining: "text-warning",
	unknown: "text-muted-foreground",
};

type Draft = {
	readonly name: string;
	readonly kind: MachineKind;
	readonly host: string;
	readonly port: string;
	readonly capabilities: string;
	readonly secretRef: string;
	readonly healthUrl: string;
};

const emptyDraft: Draft = {
	name: "",
	kind: "other",
	host: "",
	port: "",
	capabilities: "",
	secretRef: "",
	healthUrl: "",
};

const draftToInput = (d: Draft) => ({
	name: d.name.trim(),
	kind: d.kind,
	host: d.host.trim(),
	...(d.port.trim() !== "" ? { port: Number(d.port) } : {}),
	...(d.capabilities.trim() !== ""
		? {
				capabilities: d.capabilities
					.split(",")
					.map((c) => c.trim())
					.filter((c) => c !== ""),
			}
		: {}),
	...(d.secretRef.trim() !== "" ? { secretRef: d.secretRef.trim() } : {}),
	...(d.healthUrl.trim() !== "" ? { healthUrl: d.healthUrl.trim() } : {}),
});

/**
 * Machine registry view (P-098 D1/D2): platform-admin CRUD + health
 * probes over `Machines`. Registry only — no execution; `secretRef`
 * stays a `vault:` pointer and never carries material.
 *
 * Built on the shared table kit (`@ktb/views/table`): `TablePage` shell
 * and `Column` model; delete goes through `ConfirmAction`. Mutations
 * stay on the injected `MachinesApi` (not server fns) and refresh via
 * `checkAll`, so `useServerMutation`/`useTableQuery` do not apply — the
 * create dialog keeps its Select/hint fields that `FormDialog` cannot
 * express.
 */
export function MachinesPage({
	machines,
	api,
	locale = "en",
}: {
	readonly machines: readonly MachineCard[];
	readonly api: MachinesApi;
	readonly locale?: string;
}) {
	const m = machineMessages(locale);
	const [rows, setRows] = useState<readonly MachineCard[]>(machines);
	const [dialogOpen, setDialogOpen] = useState(false);
	const [draft, setDraft] = useState<Draft>(emptyDraft);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const statusLabel = (s: MachineStatus) =>
		s === "online"
			? m.statusOnline
			: s === "offline"
				? m.statusOffline
				: s === "draining"
					? m.statusDraining
					: m.statusUnknown;

	const run = async (op: () => Promise<{ readonly ok: boolean }>) => {
		setBusy(true);
		setError(null);
		try {
			const res = await op();
			if (!res.ok) setError(m.actionFailed);
			return res.ok;
		} finally {
			setBusy(false);
		}
	};

	const refresh = async () => {
		const res = await api.checkAll();
		if (res.ok && res.data !== undefined) setRows(res.data);
	};

	const save = async () => {
		const ok = await run(() => api.create(draftToInput(draft)));
		if (ok) {
			setDialogOpen(false);
			setDraft(emptyDraft);
			await refresh();
		}
	};

	const check = async (id: number) => {
		const res = await api.check(id);
		if (res.ok) await refresh();
		else setError(m.actionFailed);
	};

	const toggle = async (row: MachineCard) => {
		await run(() => api.update({ id: row.id, enabled: !row.enabled }));
		await refresh();
	};

	const remove = async (row: MachineCard) => {
		const ok = await run(() => api.remove(row.id));
		if (ok) await refresh();
	};

	const columns: Column<MachineCard>[] = [
		{
			key: "name",
			header: m.name,
			render: (row) => (
				<div>
					<div className="font-medium">{row.name}</div>
					{row.secretRef !== null && (
						<div className="text-xs text-muted-foreground">{row.secretRef}</div>
					)}
					{!row.enabled && <div className="text-xs text-warning">{m.disable}</div>}
				</div>
			),
		},
		{ key: "kind", header: m.kind },
		{
			key: "host",
			header: m.host,
			render: (row) => `${row.host}${row.port !== null ? `:${row.port}` : ""}`,
		},
		{
			key: "status",
			header: m.status,
			render: (row) => (
				<span className={STATUS_TONE[row.status]}>{statusLabel(row.status)}</span>
			),
		},
		{
			key: "lastSeen",
			header: m.lastSeen,
			render: (row) => (
				<LocalDateTime value={row.lastSeenAt} locale={locale} fallback="—" />
			),
		},
		{
			key: "lastCheck",
			header: m.lastCheck,
			render: (row) => (
				<LocalDateTime value={row.lastCheckAt} locale={locale} fallback="—" />
			),
		},
		{
			key: "actions",
			header: m.check,
			align: "right",
			render: (row) => (
				<div className="flex justify-end gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => void check(row.id)}
					>
						{m.check}
					</Button>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						disabled={busy}
						onClick={() => void toggle(row)}
					>
						{row.enabled ? m.disable : m.enable}
					</Button>
					<ConfirmAction
						trigger={(open) => (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								disabled={busy}
								onClick={open}
							>
								{m.delete}
							</Button>
						)}
						title={m.delete}
						description={m.confirmDelete}
						confirmLabel={m.delete}
						cancelLabel={m.cancel}
						variant="destructive"
						onConfirm={() => remove(row)}
					/>
				</div>
			),
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={m.title}
				description={m.desc}
				actions={
					<>
						<Button
							type="button"
							variant="outline"
							size="sm"
							disabled={busy}
							onClick={() => void refresh()}
						>
							{m.checkAll}
						</Button>
						<Button type="button" size="sm" onClick={() => setDialogOpen(true)}>
							{m.add}
						</Button>
					</>
				}
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<TablePage.Table
				columns={columns}
				rows={rows}
				rowKey={(row) => String(row.id)}
				empty={{ title: m.empty }}
				locale={locale}
			/>

			<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{m.add}</DialogTitle>
						<DialogDescription>{m.desc}</DialogDescription>
					</DialogHeader>
					<div className="grid gap-3">
						<Input
							placeholder={m.name}
							value={draft.name}
							onChange={(e) => setDraft({ ...draft, name: e.target.value })}
						/>
						<div className="grid grid-cols-2 gap-3">
							<Select
								items={KINDS.map((k) => ({ value: k, label: k }))}
								value={draft.kind}
								onValueChange={(v) => setDraft({ ...draft, kind: v as MachineKind })}
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
							<Input
								placeholder={m.host}
								value={draft.host}
								onChange={(e) => setDraft({ ...draft, host: e.target.value })}
							/>
						</div>
						<div className="grid grid-cols-2 gap-3">
							<Input
								placeholder={m.port}
								value={draft.port}
								onChange={(e) => setDraft({ ...draft, port: e.target.value })}
							/>
							<Input
								placeholder={m.healthUrl}
								value={draft.healthUrl}
								onChange={(e) => setDraft({ ...draft, healthUrl: e.target.value })}
							/>
						</div>
						<Input
							placeholder={m.capabilities}
							value={draft.capabilities}
							onChange={(e) => setDraft({ ...draft, capabilities: e.target.value })}
						/>
						<p className="text-xs text-muted-foreground">{m.capabilitiesHint}</p>
						<Input
							placeholder={m.secretRef}
							value={draft.secretRef}
							onChange={(e) => setDraft({ ...draft, secretRef: e.target.value })}
						/>
						<p className="text-xs text-muted-foreground">{m.secretRefHint}</p>
						<div className="flex justify-end gap-2">
							<Button variant="outline" onClick={() => setDialogOpen(false)}>
								{m.cancel}
							</Button>
							<Button
								disabled={busy || draft.name.trim() === "" || draft.host.trim() === ""}
								onClick={() => void save()}
							>
								{m.save}
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		</TablePage>
	);
}
