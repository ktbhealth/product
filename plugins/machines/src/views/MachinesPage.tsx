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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

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

const fmtDate = (value: Date | string | null | undefined, locale: string) => {
	if (value === null || value === undefined) return "—";
	const d = value instanceof Date ? value : new Date(value);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(locale);
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
	const [pendingDelete, setPendingDelete] = useState<MachineCard | null>(null);
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

	const remove = async () => {
		/* v8 ignore next -- onConfirm only fires while the dialog is open */
		if (pendingDelete === null) return;
		const ok = await run(() => api.remove(pendingDelete.id));
		setPendingDelete(null);
		if (ok) await refresh();
	};

	return (
		<div className="space-y-4 p-6">
			<div className="flex items-start justify-between gap-4">
				<div>
					<h1 className="text-xl font-semibold">{m.title}</h1>
					<p className="text-sm text-muted-foreground">{m.desc}</p>
				</div>
				<div className="flex gap-2">
					<Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>
						{m.checkAll}
					</Button>
					<Button size="sm" onClick={() => setDialogOpen(true)}>
						{m.add}
					</Button>
				</div>
			</div>

			{error !== null && <p className="text-sm text-destructive">{error}</p>}

			<Table>
				<TableHeader>
					<TableRow>
						<TableHead>{m.name}</TableHead>
						<TableHead>{m.kind}</TableHead>
						<TableHead>{m.host}</TableHead>
						<TableHead>{m.status}</TableHead>
						<TableHead>{m.lastSeen}</TableHead>
						<TableHead>{m.lastCheck}</TableHead>
						<TableHead className="text-right">{m.check}</TableHead>
					</TableRow>
				</TableHeader>
				<TableBody>
					{rows.length === 0 && (
						<TableRow>
							<TableCell colSpan={7} className="text-center text-muted-foreground">
								{m.empty}
							</TableCell>
						</TableRow>
					)}
					{rows.map((row) => (
						<TableRow key={row.id}>
							<TableCell>
								<div className="font-medium">{row.name}</div>
								{row.secretRef !== null && (
									<div className="text-xs text-muted-foreground">{row.secretRef}</div>
								)}
								{!row.enabled && <div className="text-xs text-warning">{m.disable}</div>}
							</TableCell>
							<TableCell>{row.kind}</TableCell>
							<TableCell>
								{row.host}
								{row.port !== null ? `:${row.port}` : ""}
							</TableCell>
							<TableCell className={STATUS_TONE[row.status]}>{statusLabel(row.status)}</TableCell>
							<TableCell>{fmtDate(row.lastSeenAt, locale)}</TableCell>
							<TableCell>{fmtDate(row.lastCheckAt, locale)}</TableCell>
							<TableCell className="text-right">
								<div className="flex justify-end gap-1">
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => void check(row.id)}
									>
										{m.check}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => void toggle(row)}
									>
										{row.enabled ? m.disable : m.enable}
									</Button>
									<Button
										variant="ghost"
										size="sm"
										disabled={busy}
										onClick={() => setPendingDelete(row)}
									>
										{m.delete}
									</Button>
								</div>
							</TableCell>
						</TableRow>
					))}
				</TableBody>
			</Table>

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
							<select
								className="rounded-md border bg-background px-3 py-2 text-sm"
								value={draft.kind}
								onChange={(e) => setDraft({ ...draft, kind: e.target.value as MachineKind })}
							>
								{KINDS.map((k) => (
									<option key={k} value={k}>
										{k}
									</option>
								))}
							</select>
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

			<ConfirmDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- onOpenChange only fires on close here */
					if (!open) setPendingDelete(null);
				}}
				title={m.delete}
				description={m.confirmDelete}
				confirmLabel={m.delete}
				cancelLabel={m.cancel}
				variant="destructive"
				loading={busy}
				onConfirm={() => void remove()}
			/>
		</div>
	);
}
