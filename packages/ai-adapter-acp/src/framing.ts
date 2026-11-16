/**
 * framing.ts — ACP wire framing, shared by every byte-pipe transport.
 * ACP's convention (agentclientprotocol.com): every message is ONE
 * line of JSON; `Content-Length:`-framed messages (LSP-style) are
 * also accepted since some agents pick that framing over stdio.
 *
 * Extracted from @ktb/ai-adapter-node's stdio-rpc (F3b) so the
 * spawned-agent transport AND the ai-bridge CLI speak identical wire
 * framing. Pure byte machinery — no platform APIs, workerd-safe.
 *
 * `Content-Length` counts BYTES, so the extractor works on raw bytes:
 * decoding before framing would mis-slice multibyte payloads. Feed
 * chunks with `push`, drain complete raw JSON frames with `next`.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRLF = encoder.encode("\r\n\r\n");
const LF_LF = encoder.encode("\n\n");
const CL_PREFIX = encoder.encode("Content-Length:");

export interface FrameExtractor {
	/** Append a chunk (string chunks are UTF-8 encoded). */
	readonly push: (chunk: string | Uint8Array) => void;
	/** Extract the next complete frame's raw JSON bytes, or null when
	 * the buffer holds only a partial one. A corrupt Content-Length
	 * header yields a synthetic `<corrupt header>` frame — never legal
	 * mid-stream — so the caller fails the session as malformed. */
	readonly next: () => Uint8Array | null;
}

export const makeFrameExtractor = (): FrameExtractor => {
	let buf = new Uint8Array(0);

	const indexOfSeq = (seq: Uint8Array, from = 0) => {
		outer: for (let i = from; i + seq.length <= buf.length; i++) {
			for (let j = 0; j < seq.length; j++) if (buf[i + j] !== seq[j]) continue outer;
			return i;
		}
		return -1;
	};

	const push = (chunk: string | Uint8Array) => {
		const bytes = typeof chunk === "string" ? encoder.encode(chunk) : chunk;
		const next = new Uint8Array(buf.length + bytes.length);
		next.set(buf);
		next.set(bytes, buf.length);
		buf = next;
	};

	const takeFrame = (): Uint8Array | null => {
		if (indexOfSeq(CL_PREFIX) === 0) {
			let sep = indexOfSeq(CRLF);
			let headerEnd = sep + CRLF.length;
			if (sep === -1) {
				sep = indexOfSeq(LF_LF);
				headerEnd = sep + LF_LF.length;
			}
			if (sep === -1) return null;
			const len = Number(
				/Content-Length:\s*(\d+)/i.exec(decoder.decode(buf.subarray(0, sep)))?.[1],
			);
			if (!Number.isFinite(len)) {
				// Corrupt header — drop it and surface a non-JSON frame so
				// the caller fails the session as malformed framing.
				buf = buf.subarray(headerEnd);
				return encoder.encode("<corrupt header>");
			}
			if (buf.length - headerEnd < len) return null;
			const frame = buf.subarray(headerEnd, headerEnd + len);
			buf = buf.subarray(headerEnd + len);
			return frame;
		}
		const nl = buf.indexOf(0x0a);
		if (nl === -1) return null;
		const frame = buf.subarray(0, nl);
		buf = buf.subarray(nl + 1);
		return frame;
	};

	return { push, next: takeFrame };
};

/** Decode one frame's bytes to text (caller JSON.parses). */
export const decodeFrame = (frame: Uint8Array): string => decoder.decode(frame);
