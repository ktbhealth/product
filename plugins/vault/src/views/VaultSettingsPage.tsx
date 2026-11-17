import { useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { KeyRoundIcon, MonitorSmartphoneIcon } from "lucide-react";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { ConfirmDialog } from "@ktbhealth/ui/components/confirm-dialog";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";

import type { KeyringService } from "@ktb/crypto/keyring";

import type { ClinicKey } from "../index.ts";
import { clearByokConfig, loadByokConfig, saveByokConfig } from "../byok.ts";
import {
	approvalEnvelope,
	enrollmentKeys,
	newClinicMasterKey,
	restoreFromPhrase,
	wrapMasterFor,
} from "../onboarding.ts";
import { vaultMessages, type VaultMessages } from "../i18n.ts";

/** Loader payload for the vault page — bound-tenant scope only. */
export interface VaultPageData {
	readonly tenantId: number | null;
	readonly role: string | null;
	readonly zk: boolean;
	readonly devices: readonly ClinicKey[];
}

/** Small mutation surface the view needs — bound to this plugin's
 * server fns by ./apis.ts, mocked in tests. */
export interface VaultApi {
	readonly enroll: (input: {
		readonly wrapPublicKey: string;
		readonly signPublicKey: string;
	}) => Promise<{ readonly ok: boolean; readonly data?: ClinicKey }>;
	readonly approve: (input: {
		readonly clinicKeyId: number;
		readonly wrappedMasterKey: string;
	}) => Promise<{ readonly ok: boolean }>;
	readonly revoke: (clinicKeyId: number) => Promise<{ readonly ok: boolean }>;
	readonly enableZk: () => Promise<{ readonly ok: boolean }>;
}

const isAdmin = (role: string | null) => role === "admin" || role === "owner";

/** Short display form of a b64url device pubkey. */
const shortKey = (pubkey: string) => `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;

const statusLabel = (t: VaultMessages, status: string) =>
	status === "approved"
		? t.statusApproved
		: status === "revoked"
			? t.statusRevoked
			: t.statusPending;

/**
 * /portal/<instance>/vault — clinic key onboarding and device approval.
 * The page itself is a client surface: the device's keypair lives in
 * IndexedDB (non-extractable) so enrollment state can only resolve in
 * the browser. All wrapping happens via the injected KeyringService —
 * the server fns only ever persist pubkeys and `w1.` envelopes.
 */
export function VaultSettingsPage({
	data,
	api,
	keyring,
	locale = "en",
}: {
	readonly data: VaultPageData;
	readonly api: VaultApi;
	readonly keyring: KeyringService;
	readonly locale?: string;
}) {
	const t = vaultMessages(locale);
	const router = useRouter();
	const admin = isAdmin(data.role);

	// This device's pubkeys resolve client-side — the keypair never
	// leaves IndexedDB/crypto.subtle.
	const [ownPubkey, setOwnPubkey] = useState<string | null>(null);
	useEffect(() => {
		let live = true;
		void enrollmentKeys(keyring).then((keys) => {
			if (live) setOwnPubkey(keys.wrapPublicKey);
		});
		return () => {
			live = false;
		};
	}, [keyring]);

	const ownDevice = useMemo(
		() => data.devices.find((d) => d.wrapPublicKey === ownPubkey) ?? null,
		[data.devices, ownPubkey],
	);

	const [error, setError] = useState(false);
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(() => void router.invalidate(), [router]);
	const fail = useCallback(() => setError(true), []);

	// ── Enable-zk bootstrap: phrase is generated up-front so canceling
	// the dialog writes nothing. Confirm persists enroll → zk → approve
	// (self) in one go — the master key is self-wrapped to this device.
	const [phrase, setPhrase] = useState<string | null>(null);
	const [pendingMaster, setPendingMaster] = useState<CryptoKey | null>(null);
	const [copied, setCopied] = useState(false);

	const closePhraseDialog = useCallback(() => {
		setPhrase(null);
		setPendingMaster(null);
		setCopied(false);
	}, []);

	const startEnable = useCallback(async () => {
		setError(false);
		const { key, phrase: next } = await newClinicMasterKey();
		setPendingMaster(key);
		setPhrase(next);
	}, []);

	const confirmEnable = useCallback(async () => {
		/* v8 ignore next -- confirm only renders while a phrase is pending */
		if (pendingMaster === null || phrase === null) return;
		setBusy(true);
		try {
			const keys = await enrollmentKeys(keyring);
			const enrolled = await api.enroll(keys);
			if (!enrolled.ok || enrolled.data === undefined) return fail();
			if (!(await api.enableZk()).ok) return fail();
			const selfWrap = await wrapMasterFor(keyring, pendingMaster, keys.wrapPublicKey);
			if (!(await api.approve({ clinicKeyId: enrolled.data.id, wrappedMasterKey: selfWrap })).ok) {
				return fail();
			}
			setPhrase(null);
			setPendingMaster(null);
			refresh();
		} finally {
			setBusy(false);
		}
	}, [api, fail, keyring, pendingMaster, phrase, refresh]);

	const copyPhrase = useCallback(async () => {
		/* v8 ignore next -- copy only renders inside the open phrase dialog */
		if (phrase === null) return;
		try {
			await navigator.clipboard.writeText(phrase);
			setCopied(true);
		} catch {
			// Clipboard may be unavailable (permissions, non-secure context)
			// — the phrase stays visible for manual copy.
		}
	}, [phrase]);

	// ── Device enrollment for an unregistered browser (zk already on).
	const enroll = useCallback(async () => {
		setError(false);
		setBusy(true);
		try {
			const keys = await enrollmentKeys(keyring);
			if (!(await api.enroll(keys)).ok) return fail();
			refresh();
		} finally {
			setBusy(false);
		}
	}, [api, fail, keyring, refresh]);

	// ── Admin approval: unwrap own master (own enrollment's envelope)
	// and re-wrap to the pending device's pubkey.
	const [approving, setApproving] = useState<ClinicKey | null>(null);
	const confirmApprove = useCallback(async () => {
		/* v8 ignore next -- approve only renders to approved admins */
		if (approving === null || ownDevice?.wrappedMasterKey == null) return;
		setBusy(true);
		try {
			const wrappedMasterKey = await approvalEnvelope(
				keyring,
				ownDevice.wrappedMasterKey,
				approving.wrapPublicKey,
			);
			if (!(await api.approve({ clinicKeyId: approving.id, wrappedMasterKey })).ok) {
				return fail();
			}
			setApproving(null);
			refresh();
		} finally {
			setBusy(false);
		}
	}, [api, approving, fail, keyring, ownDevice, refresh]);

	// ── Revocation (admin; the service also lets members revoke their own).
	const [revoking, setRevoking] = useState<ClinicKey | null>(null);
	const confirmRevoke = useCallback(async () => {
		/* v8 ignore next -- confirm only reachable while a device is targeted */
		if (revoking === null) return;
		setBusy(true);
		try {
			if (!(await api.revoke(revoking.id)).ok) return fail();
			setRevoking(null);
			refresh();
		} finally {
			setBusy(false);
		}
	}, [api, fail, refresh, revoking]);

	// ── Recovery phrase → self-approval (lost-device escape hatch):
	// import the phrase, enroll this device, then self-approve with the
	// restored master wrapped to it (admin role only — members still
	// wait for an admin approval after enrolling).
	const [phraseInput, setPhraseInput] = useState("");
	const restore = useCallback(async () => {
		setError(false);
		setBusy(true);
		try {
			const { selfWrap } = await restoreFromPhrase(keyring, phraseInput);
			const keys = await enrollmentKeys(keyring);
			const enrolled = ownDevice === null ? await api.enroll(keys) : { ok: true, data: ownDevice };
			if (!enrolled.ok || enrolled.data === undefined) return fail();
			if (
				admin &&
				!(await api.approve({ clinicKeyId: enrolled.data.id, wrappedMasterKey: selfWrap })).ok
			) {
				return fail();
			}
			setPhraseInput("");
			refresh();
		} catch {
			fail();
		} finally {
			setBusy(false);
		}
	}, [admin, api, fail, keyring, ownDevice, phraseInput, refresh]);

	// ── BYOK extraction key (T-146): optional provider key sealed to
	// this device; without one the ZK consult pipeline stays on the
	// local heuristic. The key is write-only — never rendered back.
	const [byokConfigured, setByokConfigured] = useState<boolean | null>(null);
	const [byokModel, setByokModel] = useState("");
	const [byokBaseUrl, setByokBaseUrl] = useState("");
	const [byokApiKey, setByokApiKey] = useState("");
	useEffect(() => {
		if (!data.zk) return;
		let live = true;
		loadByokConfig(keyring)
			.then((config) => {
				if (!live) return;
				setByokConfigured(config !== null);
				if (config !== null) {
					setByokModel(config.model);
					setByokBaseUrl(config.baseUrl ?? "");
				}
			})
			.catch(() => {
				if (live) setByokConfigured(false);
			});
		return () => {
			live = false;
		};
	}, [data.zk, keyring]);

	const saveByok = useCallback(async () => {
		const apiKey = byokApiKey.trim();
		/* v8 ignore next -- the save button is disabled while the key is empty */
		if (apiKey === "") return;
		setError(false);
		setBusy(true);
		try {
			const baseUrl = byokBaseUrl.trim();
			await saveByokConfig(keyring, {
				apiKey,
				model: byokModel.trim() || "gpt-4o-mini",
				...(baseUrl === "" ? {} : { baseUrl }),
			});
			setByokApiKey("");
			setByokConfigured(true);
		} catch {
			fail();
		} finally {
			setBusy(false);
		}
	}, [byokApiKey, byokBaseUrl, byokModel, fail, keyring]);

	const clearByok = useCallback(async () => {
		setError(false);
		setBusy(true);
		try {
			await clearByokConfig(keyring);
			setByokConfigured(false);
			setByokApiKey("");
			setByokModel("");
			setByokBaseUrl("");
		} catch {
			fail();
		} finally {
			setBusy(false);
		}
	}, [fail, keyring]);

	if (data.tenantId === null) {
		return (
			<PageContainer>
				<PageHeader title={t.title} description={t.description} />
				<Empty className="border">
					<EmptyHeader>
						<EmptyTitle>{t.title}</EmptyTitle>
						<EmptyDescription>{t.personalScope}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			</PageContainer>
		);
	}

	return (
		<PageContainer>
			<PageHeader
				title={t.title}
				description={t.description}
				actions={
					<Badge variant={data.zk ? "default" : "outline"}>{data.zk ? t.zkOn : t.zkOff}</Badge>
				}
			/>
			{error ? <p className="text-sm text-destructive">{t.actionFailed}</p> : null}

			{!data.zk ? (
				<div className="rounded-lg border border-border p-4">
					<h2 className="text-sm font-medium">{t.nonZkTitle}</h2>
					<p className="mt-1 text-sm text-muted-foreground">
						{admin ? t.nonZkAdmin : t.nonZkMember}
					</p>
					{admin ? (
						<Button className="mt-3" onClick={() => void startEnable()} disabled={busy}>
							<KeyRoundIcon className="size-4" />
							{t.enableZk}
						</Button>
					) : null}
				</div>
			) : (
				<>
					<div className="flex items-center justify-between gap-3">
						<h2 className="flex items-center gap-2 text-sm font-medium">
							<MonitorSmartphoneIcon className="size-4" />
							{t.devicesTitle}
						</h2>
						{ownDevice === null && ownPubkey !== null ? (
							<Button size="sm" onClick={() => void enroll()} disabled={busy}>
								{t.enrollThisDevice}
							</Button>
						) : null}
					</div>
					{ownDevice?.status === "pending" ? (
						<p className="text-sm text-muted-foreground">{t.pendingApproval}</p>
					) : null}
					<div className="overflow-hidden rounded-lg border border-border">
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>{t.colDevice}</TableHead>
									<TableHead>{t.colMember}</TableHead>
									<TableHead>{t.colStatus}</TableHead>
									<TableHead>{t.colCreated}</TableHead>
									<TableHead className="text-right">{t.colActions}</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{data.devices.length === 0 ? (
									<TableRow>
										<TableCell colSpan={5} className="text-xs text-muted-foreground">
											{t.devicesEmpty}
										</TableCell>
									</TableRow>
								) : (
									data.devices.map((device) => (
										<TableRow key={device.id}>
											<TableCell className="font-mono text-xs">
												{shortKey(device.wrapPublicKey)}
												{device.wrapPublicKey === ownPubkey ? (
													<span className="ml-2 text-muted-foreground">({t.thisDevice})</span>
												) : null}
											</TableCell>
											<TableCell className="text-xs">{device.userId}</TableCell>
											<TableCell>{statusLabel(t, device.status)}</TableCell>
											<TableCell className="text-xs text-muted-foreground">
												{device.createdAt.toLocaleString(locale)}
											</TableCell>
											<TableCell className="text-right">
												{admin &&
												device.status === "pending" &&
												ownDevice?.status === "approved" ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => setApproving(device)}
														disabled={busy}
													>
														{t.approve}
													</Button>
												) : null}
												{admin && device.status === "approved" ? (
													<Button
														size="sm"
														variant="outline"
														onClick={() => setRevoking(device)}
														disabled={busy}
													>
														{t.revoke}
													</Button>
												) : null}
											</TableCell>
										</TableRow>
									))
								)}
							</TableBody>
						</Table>
					</div>

					<div className="rounded-lg border border-border p-4">
						<h3 className="text-sm font-medium">{t.restoreTitle}</h3>
						<p className="mt-1 text-sm text-muted-foreground">{t.restoreDescription}</p>
						<div className="mt-3 flex items-center gap-2">
							<Input
								value={phraseInput}
								onChange={(e) => setPhraseInput(e.target.value)}
								placeholder={t.phrasePlaceholder}
								aria-label={t.restoreTitle}
								className="font-mono text-xs"
							/>
							<Button
								variant="outline"
								onClick={() => void restore()}
								disabled={busy || phraseInput.trim() === ""}
							>
								{t.restore}
							</Button>
						</div>
					</div>

					<div className="rounded-lg border border-border p-4">
						<h3 className="text-sm font-medium">{t.byokTitle}</h3>
						<p className="mt-1 text-sm text-muted-foreground">{t.byokDescription}</p>
						<p className="mt-2 text-xs text-muted-foreground">
							{byokConfigured === true ? t.byokConfigured : t.byokNotConfigured}
						</p>
						<div className="mt-3 grid gap-2 sm:grid-cols-2">
							<Input
								value={byokModel}
								onChange={(e) => setByokModel(e.target.value)}
								placeholder="gpt-4o-mini"
								aria-label={t.byokModelLabel}
							/>
							<Input
								value={byokBaseUrl}
								onChange={(e) => setByokBaseUrl(e.target.value)}
								placeholder="https://llm.example.com/v1"
								aria-label={t.byokBaseUrlLabel}
							/>
							<Input
								type="password"
								value={byokApiKey}
								onChange={(e) => setByokApiKey(e.target.value)}
								aria-label={t.byokApiKeyLabel}
								autoComplete="off"
								className="sm:col-span-2"
							/>
						</div>
						<div className="mt-3 flex items-center gap-2">
							<Button
								variant="outline"
								onClick={() => void saveByok()}
								disabled={busy || byokApiKey.trim() === ""}
							>
								{t.byokSave}
							</Button>
							{byokConfigured === true ? (
								<Button variant="ghost" onClick={() => void clearByok()} disabled={busy}>
									{t.byokClear}
								</Button>
							) : null}
						</div>
					</div>
				</>
			)}

			<Dialog
				open={phrase !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- mounted only while phrase set; only close events fire */
					if (!open) closePhraseDialog();
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t.phraseTitle}</DialogTitle>
						<DialogDescription>{t.phraseWarning}</DialogDescription>
					</DialogHeader>
					<p className="rounded-md bg-muted p-3 font-mono text-sm break-all select-all">{phrase}</p>
					<div className="flex items-center justify-end gap-2">
						<Button variant="ghost" onClick={closePhraseDialog}>
							{t.cancel}
						</Button>
						<Button variant="outline" onClick={() => void copyPhrase()}>
							{copied ? t.copied : t.copy}
						</Button>
						<Button onClick={() => void confirmEnable()} disabled={busy}>
							{t.phraseConfirm}
						</Button>
					</div>
				</DialogContent>
			</Dialog>

			<ConfirmDialog
				open={approving !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- mounted only while approving; only close events fire */
					if (!open) setApproving(null);
				}}
				title={t.approveTitle}
				description={t.approveDescription(approving?.userId ?? "")}
				confirmLabel={t.approve}
				cancelLabel={t.cancel}
				loading={busy}
				onConfirm={() => void confirmApprove()}
			/>
			<ConfirmDialog
				open={revoking !== null}
				onOpenChange={(open) => {
					/* v8 ignore next -- mounted only while revoking; only close events fire */
					if (!open) setRevoking(null);
				}}
				title={t.revokeTitle}
				description={t.revokeDescription(revoking?.userId ?? "")}
				confirmLabel={t.revoke}
				cancelLabel={t.cancel}
				variant="destructive"
				loading={busy}
				onConfirm={() => void confirmRevoke()}
			/>
		</PageContainer>
	);
}
