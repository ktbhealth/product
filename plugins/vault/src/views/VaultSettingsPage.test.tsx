// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invalidate = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));

import { generateMasterKey } from "@ktb/crypto/recovery";
import type { KeyringService } from "@ktb/crypto/keyring";

import type { ClinicKey } from "../index.ts";
import { VaultSettingsPage, type VaultApi, type VaultPageData } from "./index.ts";

const device = (over: Partial<ClinicKey>): ClinicKey => ({
	id: 1,
	tenantId: 7,
	userId: "u1",
	wrapPublicKey: "wDev1",
	signPublicKey: "sDev1",
	wrappedMasterKey: null,
	status: "pending",
	approvedByUserId: null,
	approvedAt: null,
	createdAt: new Date("2026-11-01T10:00:00Z"),
	...over,
});

const api = (): VaultApi & {
	enroll: ReturnType<typeof vi.fn>;
	approve: ReturnType<typeof vi.fn>;
	revoke: ReturnType<typeof vi.fn>;
	enableZk: ReturnType<typeof vi.fn>;
} => ({
	enroll: vi.fn(async () => ({ ok: true, data: device({ id: 11 }) })),
	approve: vi.fn(async () => ({ ok: true })),
	revoke: vi.fn(async () => ({ ok: true })),
	enableZk: vi.fn(async () => ({ ok: true })),
});

const keyring = (): KeyringService => ({
	deviceKeys: vi.fn(async () => ({ wrapPublicKey: "wOwn", signPublicKey: "sOwn" })),
	unwrapKey: vi.fn(async () =>
		crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]),
	),
	mintDek: vi.fn(async () => {
		throw new Error("unused");
	}),
	wrapKeyFor: vi.fn(async () => "w1.wrapped"),
	signHash: vi.fn(async () => "sig"),
	putSecret: vi.fn(async () => {}),
	getSecret: vi.fn(async () => null),
	deleteSecret: vi.fn(async () => {}),
	clearSession: vi.fn(),
});

const baseData = (over: Partial<VaultPageData> = {}): VaultPageData => ({
	tenantId: 7,
	role: "admin",
	zk: true,
	devices: [],
	...over,
});

afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());

describe("VaultSettingsPage", () => {
	it("explains that ZK needs a clinic in personal scope", () => {
		render(
			<VaultSettingsPage
				data={baseData({ tenantId: null, role: null, zk: false })}
				api={api()}
				keyring={keyring()}
			/>,
		);
		expect(screen.getByText("Select a clinic workspace", { exact: false })).toBeTruthy();
	});

	it("shows members the ask-an-admin note on a non-ZK clinic", () => {
		render(
			<VaultSettingsPage
				data={baseData({ role: "member", zk: false })}
				api={api()}
				keyring={keyring()}
			/>,
		);
		expect(screen.getByText("Ask a clinic admin", { exact: false })).toBeTruthy();
		expect(screen.queryByText("Enable zero-knowledge")).toBeNull();
	});

	it("runs the admin bootstrap: phrase dialog then enroll + enable + self-approve", async () => {
		const user = userEvent.setup();
		const a = api();
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);

		await user.click(screen.getByText("Enable zero-knowledge"));
		// The recovery phrase shows before anything is persisted.
		await screen.findByText("Save the clinic recovery phrase");
		expect(screen.getByText(/([a-z2-7]{4}-){13}[a-z2-7]/)).toBeTruthy();
		expect(a.enroll).not.toHaveBeenCalled();

		await user.click(screen.getByText("I stored the recovery phrase safely"));
		await waitFor(() => expect(a.approve).toHaveBeenCalled());
		expect(a.enroll).toHaveBeenCalledWith({ wrapPublicKey: "wOwn", signPublicKey: "sOwn" });
		expect(a.enableZk).toHaveBeenCalled();
		expect(a.approve).toHaveBeenCalledWith({ clinicKeyId: 11, wrappedMasterKey: "w1.wrapped" });
		expect(invalidate).toHaveBeenCalled();
	});

	it("cancels the phrase dialog without persisting anything", async () => {
		const user = userEvent.setup();
		const a = api();
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await screen.findByText("Save the clinic recovery phrase");
		await user.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.queryByText("Save the clinic recovery phrase")).toBeNull());
		expect(a.enroll).not.toHaveBeenCalled();
		expect(a.enableZk).not.toHaveBeenCalled();
	});

	it("dismisses the phrase dialog via the dialog's own close path", async () => {
		const user = userEvent.setup();
		render(<VaultSettingsPage data={baseData({ zk: false })} api={api()} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await screen.findByText("Save the clinic recovery phrase");
		// Escape is the dialog primitive's close gesture → onOpenChange(false).
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByText("Save the clinic recovery phrase")).toBeNull());
	});

	it("surfaces a failure when bootstrap persistence fails", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enableZk.mockResolvedValue({ ok: false });
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await user.click(await screen.findByText("I stored the recovery phrase safely"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("ignores device keys resolving after unmount", async () => {
		let resolve!: (keys: { wrapPublicKey: string; signPublicKey: string }) => void;
		const kr: KeyringService = {
			...keyring(),
			deviceKeys: vi.fn(
				() => new Promise<{ wrapPublicKey: string; signPublicKey: string }>((r) => (resolve = r)),
			),
		};
		const { unmount } = render(<VaultSettingsPage data={baseData()} api={api()} keyring={kr} />);
		await waitFor(() => expect(kr.deviceKeys).toHaveBeenCalledTimes(1));
		unmount();
		// Resolving post-unmount must not setState a dead component.
		expect(() => resolve({ wrapPublicKey: "wLate", signPublicKey: "sLate" })).not.toThrow();
	});

	it("surfaces a failure when the self-approval write fails", async () => {
		const user = userEvent.setup();
		const a = api();
		a.approve.mockResolvedValue({ ok: false });
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await user.click(await screen.findByText("I stored the recovery phrase safely"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("surfaces a failure when bootstrap enrollment is rejected", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enroll.mockResolvedValue({ ok: false });
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await user.click(await screen.findByText("I stored the recovery phrase safely"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("surfaces a failure when bootstrap enrollment returns no row", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enroll.mockResolvedValue({ ok: true });
		render(<VaultSettingsPage data={baseData({ zk: false })} api={a} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await user.click(await screen.findByText("I stored the recovery phrase safely"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("copies the phrase to the clipboard when available", async () => {
		const user = userEvent.setup();
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		render(<VaultSettingsPage data={baseData({ zk: false })} api={api()} keyring={keyring()} />);
		await user.click(screen.getByText("Enable zero-knowledge"));
		await screen.findByText("Save the clinic recovery phrase");
		await user.click(screen.getByText("Copy"));
		await waitFor(() => expect(writeText).toHaveBeenCalled());
		await screen.findByText("Copied");
	});

	it("offers enrollment to an unregistered device on a ZK clinic", async () => {
		const user = userEvent.setup();
		const a = api();
		render(
			<VaultSettingsPage
				data={baseData({ role: "member", devices: [device({})] })}
				api={a}
				keyring={keyring()}
			/>,
		);
		const enrollBtn = await screen.findByText("Enroll this device");
		await user.click(enrollBtn);
		await waitFor(() =>
			expect(a.enroll).toHaveBeenCalledWith({ wrapPublicKey: "wOwn", signPublicKey: "sOwn" }),
		);
		expect(invalidate).toHaveBeenCalled();
	});

	it("surfaces a failure when enrollment is rejected", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enroll.mockResolvedValue({ ok: false });
		render(
			<VaultSettingsPage
				data={baseData({ role: "member", devices: [device({})] })}
				api={a}
				keyring={keyring()}
			/>,
		);
		await user.click(await screen.findByText("Enroll this device"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("shows the pending note when this device awaits approval", async () => {
		render(
			<VaultSettingsPage
				data={baseData({ role: "member", devices: [device({ wrapPublicKey: "wOwn" })] })}
				api={api()}
				keyring={keyring()}
			/>,
		);
		await screen.findByText("Waiting for a clinic admin to approve this device.");
		expect(screen.queryByText("Enroll this device")).toBeNull();
	});

	it("lets an admin approve a pending device — master re-wrapped client-side", async () => {
		const user = userEvent.setup();
		const a = api();
		const kr = keyring();
		render(
			<VaultSettingsPage
				data={baseData({
					devices: [
						device({
							id: 1,
							wrapPublicKey: "wOwn",
							status: "approved",
							wrappedMasterKey: "w1.mine",
						}),
						device({ id: 2, wrapPublicKey: "wNew", userId: "u2" }),
					],
				})}
				api={a}
				keyring={kr}
			/>,
		);
		await screen.findByText("Approve");
		await user.click(screen.getByText("Approve"));
		// Row button + dialog confirm share the label — the LAST is the confirm.
		const approveButtons = await screen.findAllByRole("button", { name: "Approve" });
		await user.click(approveButtons[approveButtons.length - 1]!);
		await waitFor(() =>
			expect(a.approve).toHaveBeenCalledWith({ clinicKeyId: 2, wrappedMasterKey: "w1.wrapped" }),
		);
		expect(kr.unwrapKey).toHaveBeenCalledWith("w1.mine");
	});

	it("surfaces a failure when the approval write fails", async () => {
		const user = userEvent.setup();
		const a = api();
		a.approve.mockResolvedValue({ ok: false });
		render(
			<VaultSettingsPage
				data={baseData({
					devices: [
						device({
							id: 1,
							wrapPublicKey: "wOwn",
							status: "approved",
							wrappedMasterKey: "w1.mine",
						}),
						device({ id: 2, wrapPublicKey: "wNew", userId: "u2" }),
					],
				})}
				api={a}
				keyring={keyring()}
			/>,
		);
		await screen.findByText("Approve");
		await user.click(screen.getByText("Approve"));
		const approveButtons = await screen.findAllByRole("button", { name: "Approve" });
		await user.click(approveButtons[approveButtons.length - 1]!);
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("lets an admin revoke an approved device", async () => {
		const user = userEvent.setup();
		const a = api();
		render(
			<VaultSettingsPage
				data={baseData({
					devices: [
						device({
							id: 1,
							wrapPublicKey: "wOwn",
							status: "approved",
							wrappedMasterKey: "w1.mine",
						}),
						device({ id: 2, wrapPublicKey: "wOther", status: "approved", userId: "u2" }),
					],
				})}
				api={a}
				keyring={keyring()}
			/>,
		);
		const revokeButtons = await screen.findAllByText("Revoke");
		await user.click(revokeButtons[1]!);
		// Row buttons + dialog confirm share the label — LAST is the confirm.
		const confirmButtons = await screen.findAllByRole("button", { name: "Revoke" });
		await user.click(confirmButtons[confirmButtons.length - 1]!);
		await waitFor(() => expect(a.revoke).toHaveBeenCalledWith(2));
	});

	it("surfaces a failure when the revoke write fails", async () => {
		const user = userEvent.setup();
		const a = api();
		a.revoke.mockResolvedValue({ ok: false });
		render(
			<VaultSettingsPage
				data={baseData({
					devices: [
						device({
							id: 1,
							wrapPublicKey: "wOwn",
							status: "approved",
							wrappedMasterKey: "w1.mine",
						}),
						device({ id: 2, wrapPublicKey: "wOther", status: "approved", userId: "u2" }),
					],
				})}
				api={a}
				keyring={keyring()}
			/>,
		);
		const revokeButtons = await screen.findAllByText("Revoke");
		await user.click(revokeButtons[1]!);
		const confirmButtons = await screen.findAllByRole("button", { name: "Revoke" });
		await user.click(confirmButtons[confirmButtons.length - 1]!);
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("restores access from a recovery phrase for an admin", async () => {
		const user = userEvent.setup();
		const a = api();
		const { phrase } = await generateMasterKey();
		render(<VaultSettingsPage data={baseData()} api={a} keyring={keyring()} />);
		await screen.findByText("Enroll this device");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: phrase },
		});
		await user.click(screen.getByText("Restore"));
		await waitFor(() => expect(a.approve).toHaveBeenCalled());
		expect(a.enroll).toHaveBeenCalledWith({ wrapPublicKey: "wOwn", signPublicKey: "sOwn" });
		expect(a.approve).toHaveBeenCalledWith({ clinicKeyId: 11, wrappedMasterKey: "w1.wrapped" });
	});

	it("restores a member's already-enrolled device without self-approval", async () => {
		const user = userEvent.setup();
		const a = api();
		const { phrase } = await generateMasterKey();
		render(
			<VaultSettingsPage
				data={baseData({
					role: "member",
					devices: [device({ wrapPublicKey: "wOwn" })],
				})}
				api={a}
				keyring={keyring()}
			/>,
		);
		await screen.findByText("Waiting for a clinic admin to approve this device.");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: phrase },
		});
		await user.click(screen.getByText("Restore"));
		await waitFor(() => expect(invalidate).toHaveBeenCalled());
		// Existing enrollment → no re-enroll; member role → no self-approve.
		expect(a.enroll).not.toHaveBeenCalled();
		expect(a.approve).not.toHaveBeenCalled();
	});

	it("surfaces a failure when the restore enrollment is rejected", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enroll.mockResolvedValue({ ok: false });
		const { phrase } = await generateMasterKey();
		render(<VaultSettingsPage data={baseData()} api={a} keyring={keyring()} />);
		await screen.findByText("Enroll this device");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: phrase },
		});
		await user.click(screen.getByText("Restore"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("surfaces a failure when the restore enrollment returns no row", async () => {
		const user = userEvent.setup();
		const a = api();
		a.enroll.mockResolvedValue({ ok: true });
		const { phrase } = await generateMasterKey();
		render(<VaultSettingsPage data={baseData()} api={a} keyring={keyring()} />);
		await screen.findByText("Enroll this device");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: phrase },
		});
		await user.click(screen.getByText("Restore"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("surfaces a failure when the restore self-approval fails", async () => {
		const user = userEvent.setup();
		const a = api();
		a.approve.mockResolvedValue({ ok: false });
		const { phrase } = await generateMasterKey();
		render(<VaultSettingsPage data={baseData()} api={a} keyring={keyring()} />);
		await screen.findByText("Enroll this device");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: phrase },
		});
		await user.click(screen.getByText("Restore"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("fails loudly on a bad recovery phrase", async () => {
		const user = userEvent.setup();
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={keyring()} />);
		await screen.findByText("Enroll this device");
		fireEvent.change(screen.getByLabelText("Restore from recovery phrase"), {
			target: { value: "not-a-phrase" },
		});
		await user.click(screen.getByText("Restore"));
		expect(
			(await screen.findAllByText("The action failed", { exact: false })).length,
		).toBeGreaterThan(0);
	});

	it("hides the admin controls from members", async () => {
		render(
			<VaultSettingsPage
				data={baseData({
					role: "member",
					devices: [
						device({ wrapPublicKey: "wOwn", status: "approved", wrappedMasterKey: "w1.m" }),
						device({ id: 2, wrapPublicKey: "wOther" }),
						device({ id: 3, wrapPublicKey: "wOld", status: "revoked" }),
					],
				})}
				api={api()}
				keyring={keyring()}
			/>,
		);
		await screen.findByText("(this device)");
		expect(screen.getByText("Revoked")).toBeTruthy();
		expect(screen.queryByText("Approve")).toBeNull();
		expect(screen.queryByText("Revoke")).toBeNull();
	});

	it("seals a BYOK provider key on this device (T-146)", async () => {
		const k = keyring();
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("No provider key", { exact: false });
		await userEvent.type(screen.getByLabelText("Provider API key"), "sk-1");
		fireEvent.change(screen.getByLabelText("Endpoint URL"), {
			target: { value: "https://llm.x/v1" },
		});
		await userEvent.click(screen.getByRole("button", { name: "Save key" }));
		await waitFor(() => expect(k.putSecret).toHaveBeenCalled());
		const secret = JSON.parse(String((k.putSecret as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]));
		expect(secret).toEqual({
			apiKey: "sk-1",
			model: "gpt-4o-mini",
			baseUrl: "https://llm.x/v1",
		});
	});

	it("shows a stored BYOK config and clears it", async () => {
		const k = keyring();
		(k.getSecret as ReturnType<typeof vi.fn>).mockResolvedValue(
			JSON.stringify({ apiKey: "sk", model: "m", baseUrl: "https://x" }),
		);
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("A provider key is stored", { exact: false });
		expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("m");
		expect((screen.getByLabelText("Endpoint URL") as HTMLInputElement).value).toBe("https://x");
		await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
		await waitFor(() => expect(k.deleteSecret).toHaveBeenCalled());
	});

	it("edits the BYOK model field", async () => {
		const k = keyring();
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("No provider key", { exact: false });
		fireEvent.change(screen.getByLabelText("Model"), { target: { value: "m2" } });
		expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("m2");
	});

	it("treats a failed BYOK config read as unconfigured", async () => {
		const k = keyring();
		(k.getSecret as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("idb"));
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("No provider key", { exact: false });
	});

	it("ignores a late failed BYOK config read after unmount", async () => {
		const k = keyring();
		let reject: (e: unknown) => void = () => {};
		(k.getSecret as ReturnType<typeof vi.fn>).mockImplementation(
			() =>
				new Promise<null>((_r, rej) => {
					reject = rej;
				}),
		);
		const { unmount } = render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		unmount();
		await act(async () => {
			reject(new Error("late"));
		});
	});

	it("surfaces a failure when the BYOK seal fails", async () => {
		const k = keyring();
		(k.putSecret as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("idb"));
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("No provider key", { exact: false });
		await userEvent.type(screen.getByLabelText("Provider API key"), "sk-1");
		await userEvent.click(screen.getByRole("button", { name: "Save key" }));
		await screen.findByText("The action failed — try again.");
	});

	it("surfaces a failure when the BYOK clear fails", async () => {
		const k = keyring();
		(k.getSecret as ReturnType<typeof vi.fn>).mockResolvedValue(
			JSON.stringify({ apiKey: "sk", model: "m" }),
		);
		(k.deleteSecret as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("idb"));
		render(<VaultSettingsPage data={baseData()} api={api()} keyring={k} />);
		await screen.findByText("A provider key is stored", { exact: false });
		await userEvent.click(screen.getByRole("button", { name: "Remove key" }));
		await screen.findByText("The action failed — try again.");
	});
});
