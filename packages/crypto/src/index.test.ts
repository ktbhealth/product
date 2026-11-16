import { describe, expect, it } from "vitest";

import * as ktbCrypto from "./index.ts";

describe("@ktb/crypto index", () => {
	it("re-exports encoding helpers at the top level", () => {
		expect(typeof ktbCrypto.bytesToB64u).toBe("function");
		expect(typeof ktbCrypto.b64uToBytes).toBe("function");
		expect(typeof ktbCrypto.bytesToHex).toBe("function");
		expect(typeof ktbCrypto.hexToBytes).toBe("function");
		expect(typeof ktbCrypto.CryptoFormatError).toBe("function");
	});

	it("exposes the primitive namespaces", () => {
		for (const ns of ["aead", "wrap", "sign", "digest", "kdf", "stream", "recovery"] as const) {
			expect(ktbCrypto[ns], ns).toBeDefined();
		}
		expect(typeof ktbCrypto.aead.encrypt).toBe("function");
		expect(typeof ktbCrypto.wrap.wrapDek).toBe("function");
		expect(typeof ktbCrypto.sign.sign).toBe("function");
		expect(typeof ktbCrypto.digest.contentHash).toBe("function");
		expect(typeof ktbCrypto.kdf.hkdfToAesKey).toBe("function");
		expect(typeof ktbCrypto.stream.encryptToBlob).toBe("function");
		expect(typeof ktbCrypto.recovery.generateMasterKey).toBe("function");
	});
});
