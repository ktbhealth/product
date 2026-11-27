/** FNV-1a hex — dependency-free content hash for ids/scriptHash
 * (domain code cannot use node:crypto). Moved here from
 * `@ktb/eval-consultation` so packages below the eval workspace
 * (@ktb/transcript-cleanup's CLEANUP_PROMPT) can stamp the same
 * prompt identities. */
export const fnvHex = (s: string): string => {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(16).padStart(8, "0");
};
