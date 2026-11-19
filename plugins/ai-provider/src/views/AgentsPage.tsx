import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { CopyIcon, PlusIcon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";

import { ConfirmAction, TablePage, viewsMessages, type Column } from "@ktb/views/table";

import { createBridgeLinkFn, listAgentLinksFn, revokeAgentLinkFn } from "../fns.ts";
import { aiEndpointMessages, type AiEndpointMessages } from "../i18n.ts";
import type { AgentLinkRow, AgentLinkStatus, EndpointCard } from "../index.ts";

/** Status poll cadence — waiting → connected flips live while the
 * page is open (the bridge heartbeat lands well inside this). */
const POLL_MS = 10_000;

/** A bridge endpoint: acp+ws with no dialable URL — same client-side
 * detector the endpoints page uses (baseUrl "" is the DTO sentinel). */
const isBridgeCard = (e: EndpointCard): boolean =>
	e.kind === "acp" && (e.transport ?? "ws") === "ws" && e.baseUrl === "";

/** Relative timestamp ("3 minutes ago" / "in 15 minutes") in the
 * active locale; null/garbage renders an em dash. Wire values may be
 * Date or ISO string depending on the serialization path. */
const relative = (value: Date | string | null, locale: string): string => {
	if (value === null) return "—";
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "—";
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	const diff = d.getTime() - Date.now();
	const abs = Math.abs(diff);
	if (abs < 60_000) return rtf.format(Math.trunc(diff / 1_000), "second");
	if (abs < 3_600_000) return rtf.format(Math.trunc(diff / 60_000), "minute");
	if (abs < 86_400_000) return rtf.format(Math.trunc(diff / 3_600_000), "hour");
	return rtf.format(Math.trunc(diff / 86_400_000), "day");
};

const STATUS_LABEL: Record<AgentLinkStatus, keyof AiEndpointMessages> = {
	waiting: "statusWaiting",
	connected: "statusConnected",
	offline: "statusOffline",
	expired: "statusExpired",
	revoked: "statusRevoked",
};

/** Colored liveness dot inside the status badge — one hue per state. */
const STATUS_DOT: Record<AgentLinkStatus, string> = {
	waiting: "bg-warning",
	connected: "bg-success",
	offline: "bg-muted-foreground",
	expired: "bg-info",
	revoked: "bg-destructive",
};

/** /platform/ai/agents view (F4): every bridge link joined to its
 * endpoint — mint connect commands, watch liveness, revoke. Built on
 * the shared table kit (`@ktb/views/table`): `TablePage` shell +
 * `Column` model + `ConfirmAction` for revoke; the mint dialog stays
 * plugin-local (endpoint picker + one-time command display). */
export function AgentsPage({
	links: initial,
	endpoints,
	locale,
}: {
	links: readonly AgentLinkRow[];
	endpoints: readonly EndpointCard[];
	locale: string;
}) {
	const m = aiEndpointMessages(locale);
	const router = useRouter();
	const [links, setLinks] = useState<readonly AgentLinkRow[]>(initial);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [copied, setCopied] = useState(false);
	// New-link dialog: endpointId "" until picked; command null = not
	// minted yet, "" = mint failed, otherwise the bearer command.
	const [linkDialog, setLinkDialog] = useState<{
		readonly endpointId: string;
		readonly command: string | null;
	} | null>(null);

	const bridgeEndpoints = endpoints.filter((e) => isBridgeCard(e) && e.enabled);

	const refresh = async () => {
		const r = await listAgentLinksFn();
		/* v8 ignore next -- a failed poll keeps stale rows; next tick retries */
		if (r.ok) setLinks(r.data);
	};

	// Poll while mounted — a waiting link flips to connected as soon as
	// the bridge CLI's first heartbeat lands on the DO.
	useEffect(() => {
		let stopped = false;
		const tick = async () => {
			const r = await listAgentLinksFn();
			if (stopped) return;
			/* v8 ignore next -- failed polls keep stale rows */
			if (r.ok) setLinks(r.data);
		};
		void tick();
		const timer = setInterval(() => void tick(), POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, []);

	/** Mint a link for the picked bridge endpoint — the raw
	 * command exists only in dialog state, never re-fetchable. */
	const mintLink = async () => {
		/* v8 ignore next -- the Create button only renders while the dialog is open */
		if (linkDialog === null) return;
		setBusy(true);
		setError(null);
		const r = await createBridgeLinkFn({ data: { id: Number(linkDialog.endpointId) } });
		setBusy(false);
		setLinkDialog((prev) =>
			prev === null ? prev : { ...prev, command: r.ok && r.data !== null ? r.data.command : "" },
		);
		await refresh();
		void router.invalidate();
	};

	const copyCommand = async () => {
		/* v8 ignore next -- the Copy button only renders with a non-empty command */
		if (linkDialog?.command == null || linkDialog.command === "") return;
		try {
			await navigator.clipboard.writeText(linkDialog.command);
		} catch {
			// Clipboard API unavailable — the command stays selected in
			// the read-only input for manual copy.
		}
		setCopied(true);
	};

	const revoke = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await revokeAgentLinkFn({ data: { id } });
		setBusy(false);
		if (r.ok) {
			await refresh();
			void router.invalidate();
		} else {
			setError(m.actionFailed);
		}
	};

	const columns: Column<AgentLinkRow>[] = [
		{
			key: "endpointName",
			header: m.colEndpoint,
			render: (link) => <span className="font-medium">{link.endpointName}</span>,
		},
		{
			key: "status",
			header: m.colStatus,
			render: (link) => (
				<Badge variant={link.status === "revoked" ? "destructive" : "outline"}>
					<span className={`size-1.5 rounded-full ${STATUS_DOT[link.status]}`} aria-hidden="true" />
					{m[STATUS_LABEL[link.status]]}
				</Badge>
			),
		},
		{
			key: "createdAt",
			header: m.colCreated,
			render: (link) => (
				<span className="text-muted-foreground">{relative(link.createdAt, locale)}</span>
			),
		},
		{
			key: "expiresAt",
			header: m.colExpires,
			render: (link) => (
				<span className="text-muted-foreground">{relative(link.expiresAt, locale)}</span>
			),
		},
		{
			key: "usedAt",
			header: m.colUsed,
			render: (link) => (
				<span className="text-muted-foreground">{relative(link.usedAt, locale)}</span>
			),
		},
		{
			key: "lastSeenAt",
			header: m.colLastSeen,
			render: (link) => (
				<span className="text-muted-foreground">{relative(link.lastSeenAt, locale)}</span>
			),
		},
		{
			key: "actions",
			header: "",
			width: "6rem",
			render: (link) =>
				// Terminal states have nothing left to pull.
				link.status !== "expired" && link.status !== "revoked" ? (
					<ConfirmAction
						trigger={(open) => (
							<Button variant="outline" size="sm" disabled={busy} onClick={open}>
								{m.revoke}
							</Button>
						)}
						title={m.revokeTitle}
						description={m.revokeDesc}
						confirmLabel={m.confirmRevoke}
						cancelLabel={m.cancel}
						variant="destructive"
						onConfirm={() => revoke(link.id)}
					/>
				) : null,
		},
	];

	return (
		<TablePage messages={viewsMessages(locale)}>
			<TablePage.Header
				title={m.agentsTitle}
				description={m.agentsDesc}
				actions={
					<Button
						onClick={() => {
							setCopied(false);
							setLinkDialog({ endpointId: "", command: null });
						}}
					>
						<PlusIcon className="mr-1 size-4" />
						{m.newAgentLink}
					</Button>
				}
			/>
			{error !== null && <p className="text-sm text-destructive">{error}</p>}
			<TablePage.Table
				columns={columns}
				rows={links}
				empty={{ title: m.agentsTitle, description: m.emptyAgentLinks }}
			/>

			<Dialog open={linkDialog !== null} onOpenChange={(open) => !open && setLinkDialog(null)}>
				<DialogContent className="sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>{m.bridgeTitle}</DialogTitle>
					</DialogHeader>
					{linkDialog !== null && linkDialog.command === null && (
						<div className="grid gap-3">
							<p className="text-sm text-muted-foreground">{m.bridgeDesc}</p>
							{bridgeEndpoints.length === 0 ? (
								<p className="text-sm text-muted-foreground">{m.noBridgeEndpoints}</p>
							) : (
								<Field>
									<FieldLabel>{m.linkEndpointLabel}</FieldLabel>
									<Select
										value={linkDialog.endpointId}
										onValueChange={(v) => {
											// Radix re-fires with null when the held option unmounts.
											/* v8 ignore next -- select options never unmount in this dialog */
											if (v === null) return;
											setLinkDialog({ endpointId: String(v), command: null });
										}}
									>
										<SelectTrigger aria-label={m.linkEndpointLabel}>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{bridgeEndpoints.map((e) => (
												<SelectItem key={e.id} value={String(e.id)}>
													{e.name}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</Field>
							)}
						</div>
					)}
					{linkDialog !== null && linkDialog.command !== null && (
						<div className="grid gap-3">
							{linkDialog.command === "" ? (
								<p className="text-sm text-destructive">{m.actionFailed}</p>
							) : (
								<>
									<p className="text-sm text-muted-foreground">{m.linkShownOnce}</p>
									<div className="flex gap-2">
										<Input readOnly value={linkDialog.command} aria-label={m.bridgeTitle} />
										<Button variant="outline" size="sm" onClick={() => void copyCommand()}>
											<CopyIcon className="mr-1 size-3" />
											{copied ? m.bridgeCopied : m.bridgeCopy}
										</Button>
									</div>
								</>
							)}
						</div>
					)}
					<DialogFooter>
						{linkDialog?.command === null && (
							<Button
								disabled={busy || linkDialog.endpointId === "" || bridgeEndpoints.length === 0}
								onClick={() => void mintLink()}
							>
								{m.createLink}
							</Button>
						)}
						<Button variant="outline" onClick={() => setLinkDialog(null)}>
							{m.bridgeClose}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</TablePage>
	);
}
