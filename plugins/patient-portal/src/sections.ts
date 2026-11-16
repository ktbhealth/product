import { Option } from "effect";

import { decodeAnamnesisOption } from "@ktb/anamnesis/schema";
import { SECTION_LABELS, type Anamnesis, type AnamnesisSectionKey } from "@ktb/anamnesis/types";

/**
 * Anamnesis → portal section helpers (T-148): extracted from ./index.ts
 * so the browser-side decrypt path can derive the same section list the
 * server builds for plaintext rows — the module stays client-safe
 * (anamnesis types only, no server imports).
 */

/** One section of the record the doctor saved. Drafting metadata —
 * confidence, the transcript sentences behind it — is not part of it. */
export interface PortalSection {
	readonly key: AnamnesisSectionKey;
	readonly content: string;
}

/** Prefix of the placeholder a drafter leaves in a section the doctor
 * still has to write (see the heuristic extractor and the LLM prompt). */
const UNFILLED = "A preencher pelo médico";

const SECTION_KEYS = Object.keys(SECTION_LABELS) as AnamnesisSectionKey[];

/** Stored anamnesis JSON → typed document, null on any drift — the
 * plaintext decode after a `decryptRow` hands back the stored
 * canonical string, same as for server-side plaintext columns. */
export const parseAnamnesis = (json: string | null): Anamnesis | null => {
	try {
		return Option.getOrNull(decodeAnamnesisOption(JSON.parse(json ?? "null")));
	} catch {
		return null;
	}
};

/** What the doctor actually wrote in a section, or null when it is
 * empty or still the drafter's placeholder. */
export const written = (content: string): string | null => {
	const text = content.trim();
	return text === "" || text.startsWith(UNFILLED) ? null : text;
};

/** The sections of a record the doctor filled in, in document order. */
export const portalSections = (anamnesis: Anamnesis): PortalSection[] =>
	SECTION_KEYS.flatMap((key) => {
		const content = written(anamnesis[key].content);
		return content === null ? [] : [{ key, content }];
	});
