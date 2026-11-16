import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	vaultApproveDeviceFn: vi.fn(),
	vaultEnableZkFn: vi.fn(),
	vaultEnrollDeviceFn: vi.fn(),
	vaultRevokeDeviceFn: vi.fn(),
}));

vi.mock("./fns.ts", () => mocks);

import { vaultApi } from "./apis.ts";

describe("vaultApi", () => {
	it("binds the view surface to the plugin server fns", async () => {
		mocks.vaultEnrollDeviceFn.mockResolvedValue({ ok: true });
		await vaultApi.enroll({ wrapPublicKey: "w", signPublicKey: "s" });
		expect(mocks.vaultEnrollDeviceFn).toHaveBeenCalledWith({
			data: { wrapPublicKey: "w", signPublicKey: "s" },
		});

		await vaultApi.approve({ clinicKeyId: 3, wrappedMasterKey: "w1.x" });
		expect(mocks.vaultApproveDeviceFn).toHaveBeenCalledWith({
			data: { clinicKeyId: 3, wrappedMasterKey: "w1.x" },
		});

		await vaultApi.revoke(5);
		expect(mocks.vaultRevokeDeviceFn).toHaveBeenCalledWith({ data: { clinicKeyId: 5 } });

		await vaultApi.enableZk();
		expect(mocks.vaultEnableZkFn).toHaveBeenCalledWith();
	});
});
