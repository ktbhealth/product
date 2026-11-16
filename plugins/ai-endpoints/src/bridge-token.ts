/**
 * bridge-token.ts — the ACP bridge link token (F3b). The raw token
 * is a 128-bit random value, shown ONCE inside the generated
 * `ai-bridge connect` command; only its SHA-256 ever touches the
 * table (`ai_agent_link.token_hash`). Standard WebCrypto — no
 * platform APIs, so the same module runs in the worker route and in
 * tests.
 */

const b64url = (bytes: Uint8Array): string => {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

/** Mint a raw token — the caller stores ONLY `sha256Hex(token)`. */
export const mintBridgeToken = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)));

export const sha256Hex = async (text: string): Promise<string> => {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
