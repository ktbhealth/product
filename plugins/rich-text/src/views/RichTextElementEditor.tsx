import { useState } from "react";

import type { ElementKindEditorProps } from "@ktb/kernel";
import {
	RichTextEditor,
	htmlToRichText,
	richTextToHtml,
} from "@ktbhealth/ui/components/rich-text-editor";

/** Canonical empty document — same seed the service writes on create
 * and the admin pane falls back to. */
const EMPTY_DOC: unknown = [{ type: "p", children: [{ text: "" }] }];

const asValue = (value: unknown): unknown =>
	value === null || value === undefined ? EMPTY_DOC : value;

/**
 * `elementKinds` editor for kind `"rich-text"` (P-102): adapts the
 * platejs-backed `RichTextEditor` — which exchanges sanitized HTML —
 * to the kind's `{ value, onChange }` contract. `value` is the stored
 * Plate value array (what `RichTexts.getById` returns as `content`);
 * `onChange` emits the converted Plate value so consumers persist the
 * same shape the renderer consumes.
 *
 * The editor is uncontrolled after mount (same contract as the admin
 * pane): `value` is read once for the initial HTML and later prop
 * changes do not rewrite it — consumers that swap documents remount
 * via `key`. This component is client-only: it pulls the full editor
 * stack, so it belongs on the `elementKinds` manifest, never in a
 * server-rendered path that lacks the editor bundle.
 */
export function RichTextElementEditor({ value, onChange }: ElementKindEditorProps) {
	const [html, setHtml] = useState(() => richTextToHtml(asValue(value) as never));
	return (
		<RichTextEditor
			value={html}
			onChange={(next) => {
				setHtml(next);
				onChange(htmlToRichText(next));
			}}
		/>
	);
}
