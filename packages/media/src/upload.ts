/**
 * Upload validation shared by every multipart asset route (theme
 * brand assets, catalog fonts, media-library images, consultation
 * audio). Each plugin keeps its domain specifics — allowed
 * extensions, MIME prefixes, size ceiling, deny rules — as an
 * {@link UploadPolicy}; the check order and response contract
 * (status + `{ error }` body) are uniform:
 *
 *   empty file → 400 "empty file"
 *   over maxBytes → 413 "file too large (max <N>MB)"
 *   extension outside the allowlist → 415 "unsupported file type"
 *   declared MIME outside the prefixes → 415 "unsupported content type"
 *   deny rule hit → 415 with the rule's own message
 *
 * "application/octet-stream" and an empty declared type always pass —
 * the extension is the gate (browsers lie about octet-stream uploads;
 * the deny list still applies to the declared MIME).
 */

/** The `file`/`audio` field of a parsed multipart form — null when the
 * field is absent or posted as a plain text field. */
export const multipartFile = (form: FormData, field: string): File | null => {
	const value = form.get(field);
	return value instanceof File ? value : null;
};

/** Lowercased extension of an uploaded file name ("" when absent). */
export const fileExtension = (name: string): string => {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

/** Declared MIME base type — lowercase, parameters stripped. */
export const mimeBase = (contentType: string): string =>
	(contentType.split(";")[0] ?? "").trim().toLowerCase();

/** A refuse-outright rule checked AFTER the allowlist — e.g. svg
 * (script-capable) on the image route. `extensions`/`mimes` are
 * optional; a hit on either produces `error` as the response body. */
export interface UploadDeny {
	readonly extensions?: readonly string[];
	readonly mimes?: readonly string[];
	readonly error: string;
}

export interface UploadPolicy {
	/** Byte ceiling — enforced on the buffered body before any decode. */
	readonly maxBytes: number;
	/** Accepted lowercase extensions (no dot). */
	readonly extensions: readonly string[];
	/** Accepted declared-MIME prefixes (e.g. ["image/"], ["font/"]);
	 * absent = any declared type passes (extension is the only gate). */
	readonly mimePrefixes?: readonly string[];
	/** Refuse-outright rules evaluated after the allowlist. */
	readonly deny?: readonly UploadDeny[];
}

export type UploadCheck =
	| {
			readonly ok: true;
			readonly bytes: Uint8Array;
			readonly ext: string;
			/** Normalized declared MIME ("" when the client sent none). */
			readonly mime: string;
	  }
	| { readonly ok: false; readonly status: number; readonly error: string };

const reject = (status: number, error: string): UploadCheck => ({ ok: false, status, error });

/**
 * Validate one uploaded file against `policy`. `bytes` is the fully
 * buffered body (callers buffer once — worker memory is bounded by
 * `maxBytes` upstream of any decode). `fileName`/`mime` come from the
 * parsed `File`; `mime` should already be the raw `file.type`.
 */
export const checkUpload = (
	input: {
		readonly bytes: ArrayBuffer | Uint8Array;
		readonly fileName: string;
		readonly mime: string;
	},
	policy: UploadPolicy,
): UploadCheck => {
	const size = input.bytes.byteLength;
	if (size === 0) return reject(400, "empty file");
	if (size > policy.maxBytes) {
		const mb = policy.maxBytes / (1024 * 1024);
		return reject(413, `file too large (max ${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB)`);
	}
	const ext = fileExtension(input.fileName || "upload");
	if (!policy.extensions.includes(ext)) {
		return reject(415, "unsupported file type");
	}
	const mime = mimeBase(input.mime);
	const prefixes = policy.mimePrefixes;
	if (
		prefixes !== undefined &&
		mime !== "" &&
		mime !== "application/octet-stream" &&
		!prefixes.some((prefix) => mime.startsWith(prefix))
	) {
		return reject(415, "unsupported content type");
	}
	for (const rule of policy.deny ?? []) {
		const extHit = rule.extensions?.includes(ext) === true;
		const mimeHit = rule.mimes?.includes(mime) === true;
		if (extHit || mimeHit) return reject(415, rule.error);
	}
	return {
		ok: true,
		bytes: input.bytes instanceof Uint8Array ? input.bytes : new Uint8Array(input.bytes),
		ext,
		mime,
	};
};
