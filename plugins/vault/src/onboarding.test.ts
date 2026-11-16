import { describe, expect, it } from "vitest";

import { exportDek } from "@ktb/crypto/aead";
import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";
import { decodeRecoveryPhrase } from "@ktb/crypto/recovery";

import {
	approvalEnvelope,
	enrollmentKeys,
	newClinicMasterKey,
	restoreFromPhrase,
	wrapMasterFor,
} from "./onboarding.ts";

describe("vault onboarding flows", () => {
	it("enrollmentKeys exposes both publishable pubkeys", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const keys = await enrollmentKeys(keyring);
		expect(typeof keys.wrapPublicKey).toBe("string");
		expect(typeof keys.signPublicKey).toBe("string");
		// Same device → same pubkeys (identity persists in the store).
		expect(await enrollmentKeys(keyring)).toEqual(keys);
	});

	it("bootstrap: master key self-wrap unwraps on the same device", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const { key, phrase } = await newClinicMasterKey();
		expect(phrase).toMatch(/^([a-z2-7]{4}-){13}[a-z2-7]$/);
		const { wrapPublicKey } = await enrollmentKeys(keyring);
		const envelope = await wrapMasterFor(keyring, key, wrapPublicKey);
		expect(envelope.startsWith("w1.")).toBe(true);
		const unwrapped = await keyring.unwrapKey(envelope);
		expect(await exportDek(unwrapped)).toEqual(await exportDek(key));
	});

	it("approval: admin unwraps own master and re-wraps to the new device", async () => {
		const admin = makeKeyring({ store: memoryStore() });
		const member = makeKeyring({ store: memoryStore() });
		const { key: master } = await newClinicMasterKey();
		const adminKeys = await enrollmentKeys(admin);
		const memberKeys = await enrollmentKeys(member);
		// What the admin's enrollment row would hold.
		const ownEnvelope = await wrapMasterFor(admin, master, adminKeys.wrapPublicKey);
		// The approval payload persisted for the member's device.
		const forMember = await approvalEnvelope(admin, ownEnvelope, memberKeys.wrapPublicKey);
		const unwrappedByMember = await member.unwrapKey(forMember);
		expect(await exportDek(unwrappedByMember)).toEqual(await exportDek(master));
	});

	it("restoreFromPhrase recovers the master key and self-wraps it", async () => {
		const keyring = makeKeyring({ store: memoryStore() });
		const { key: original, phrase } = await newClinicMasterKey();
		const { masterKey, selfWrap } = await restoreFromPhrase(keyring, phrase);
		expect(await exportDek(masterKey)).toEqual(await exportDek(original));
		expect(await decodeRecoveryPhrase(phrase)).toEqual(await exportDek(original));
		const unwrapped = await keyring.unwrapKey(selfWrap);
		expect(await exportDek(unwrapped)).toEqual(await exportDek(original));
	});
});
