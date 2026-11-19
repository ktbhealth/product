import { Fragment, type ReactNode } from "react";

/**
 * Public renderer for stored rich-text documents — PURE value→React,
 * deliberately free of `@ktbhealth/ui/components/rich-text-editor` and
 * platejs imports (that module pulls the whole editor stack into the
 * bundle; this view ships on public app pages). It ports the supported
 * node subset of the editor's HTML serializer: `p`, `h2`, `h3`, inline
 * `a` (http(s)/mailto only), list-item paragraphs (`listStyleType` /
 * `indent` / `listStart`) and the `bold`/`italic`/`underline` marks.
 * Everything is built as React elements — no dangerouslySetInnerHTML —
 * so stored content can never inject markup.
 */

/** Structural node shape mirroring the editor's `RichTextNode` — kept
 * local so this module never imports the platejs-backed component. */
interface RichTextNode {
	type?: string;
	text?: string;
	children?: RichTextNode[];
	url?: string;
	target?: string;
	listStyleType?: string;
	indent?: number;
	listStart?: number;
	bold?: boolean;
	italic?: boolean;
	underline?: boolean;
	[key: string]: unknown;
}

const LIST_ITEM_TYPES = new Set([
	"disc",
	"circle",
	"square",
	"disclosure-open",
	"disclosure-closed",
]);
const LIST_STYLE_TYPE_RE = /^[a-zA-Z-]+$/;

/** Only absolute http(s) and mailto URLs survive — same contract as the
 * editor's `sanitizeRichTextHref` (trimmed, ≤2048 chars). */
const safeHref = (url: unknown): string | null => {
	if (typeof url !== "string") return null;
	const trimmed = url.trim();
	if (!trimmed || trimmed.length > 2048) return null;
	if (/^(https?:\/\/|mailto:)/i.test(trimmed)) return trimmed;
	return null;
};

/** Text leaf → React node with marks applied (bold outermost, matching
 * the editor's serializer order: underline, then italic, then bold). */
const markedText = (node: RichTextNode): ReactNode => {
	let content: ReactNode = node.text ?? "";
	if (node.underline) content = <u>{content}</u>;
	if (node.italic) content = <em>{content}</em>;
	if (node.bold) content = <strong>{content}</strong>;
	return content;
};

/** Inline children → React nodes. `a` nodes become anchors only when
 * the href is safe (otherwise they unwrap to their children); unknown
 * elements unwrap the same way. */
const renderInline = (nodes: RichTextNode[] | undefined, keyPrefix = "i"): ReactNode[] => {
	const out: ReactNode[] = [];
	if (!Array.isArray(nodes)) return out;
	let n = 0;
	for (const node of nodes) {
		if (!node || typeof node !== "object") continue;
		const key = `${keyPrefix}-${n++}`;
		if (typeof node.text === "string") {
			out.push(<Fragment key={key}>{markedText(node)}</Fragment>);
			continue;
		}
		if (node.type === "a") {
			const href = safeHref(node.url);
			const inner = renderInline(node.children, key);
			if (href !== null) {
				out.push(
					<a
						key={key}
						href={href}
						target="_blank"
						rel="noreferrer"
						className="text-primary underline underline-offset-2 hover:text-primary/80"
					>
						{inner}
					</a>,
				);
			} else {
				out.push(...inner);
			}
			continue;
		}
		// Unknown inline elements are unwrapped to their children.
		out.push(...renderInline(node.children, key));
	}
	return out;
};

const isListItem = (node: RichTextNode | undefined): node is RichTextNode =>
	!!node &&
	typeof node === "object" &&
	typeof node.listStyleType === "string" &&
	LIST_STYLE_TYPE_RE.test(node.listStyleType);

const listDepth = (node: RichTextNode): number =>
	typeof node.indent === "number" && node.indent > 0 ? node.indent : 1;

const listTag = (listStyleType: string | undefined): "ul" | "ol" =>
	listStyleType && LIST_ITEM_TYPES.has(listStyleType) ? "ul" : "ol";

interface HtmlListItem {
	readonly content: ReactNode;
	readonly sub: HtmlList[];
}
interface HtmlList {
	readonly tag: "ul" | "ol";
	readonly start?: number;
	readonly items: HtmlListItem[];
}

/**
 * Group a run of consecutive list-item paragraphs into nested lists —
 * direct port of the editor's `serializeListRun`: split whenever the
 * list style type changes and nest deeper `indent` values inside the
 * previous `<li>`.
 */
const buildListRun = (items: RichTextNode[]): HtmlList[] => {
	const base = Math.min(...items.map(listDepth));
	const roots: HtmlList[] = [];
	const stack: { depth: number; list: HtmlList }[] = [];

	for (const item of items) {
		const depth = listDepth(item) - base;
		const tag = listTag(item.listStyleType);
		while (stack.length) {
			const top = stack[stack.length - 1]!;
			if (top.depth > depth || (top.depth === depth && top.list.tag !== tag)) {
				stack.pop();
			} else break;
		}
		const top = stack[stack.length - 1];
		if (!top || top.depth !== depth) {
			const list: HtmlList = { tag, items: [] };
			if (typeof item.listStart === "number" && item.listStart > 1) {
				(list as { start?: number }).start = item.listStart;
			}
			// Attach to the nearest open ancestor list, or to the root.
			let attached = false;
			for (let i = stack.length - 1; i >= 0; i--) {
				if (stack[i]!.depth < depth) {
					const parentItem = stack[i]!.list.items[stack[i]!.list.items.length - 1];
					if (parentItem) {
						parentItem.sub.push(list);
						attached = true;
						break;
					}
				}
			}
			if (!attached) roots.push(list);
			stack.push({ depth, list });
		}
		stack[stack.length - 1]!.list.items.push({
			content: renderInline(item.children, `li-${depth}`),
			sub: [],
		});
	}
	return roots;
};

const renderList = (list: HtmlList, key: number): ReactNode => {
	const Tag = list.tag;
	return (
		<Tag
			key={key}
			className={
				list.tag === "ul" ? "my-3 list-disc space-y-1 pl-6" : "my-3 list-decimal space-y-1 pl-6"
			}
			{...(list.tag === "ol" && list.start !== undefined ? { start: list.start } : {})}
		>
			{list.items.map((item, i) => (
				<li key={i}>
					{item.content}
					{item.sub.map((sub, j) => renderList(sub, j))}
				</li>
			))}
		</Tag>
	);
};

const hasOnlyInlineChildren = (node: RichTextNode): boolean => {
	const children = node.children;
	if (!Array.isArray(children) || children.length === 0) return true;
	return children.every(
		(child) =>
			!!child &&
			typeof child === "object" &&
			(typeof child.text === "string" || !child.type || child.type === "a"),
	);
};

/** One block-level node → React node (port of the editor's
 * `serializeBlock`). */
const renderBlock = (node: RichTextNode | undefined, key: number): ReactNode => {
	if (!node || typeof node !== "object") return null;
	if (typeof node.text === "string") {
		return (
			<p key={key} className="my-3 leading-7 first:mt-0">
				{markedText(node)}
			</p>
		);
	}
	const inner = renderInline(node.children, `b-${key}`);
	switch (node.type) {
		case "h2":
			return (
				<h2 key={key} className="mt-5 text-xl font-semibold tracking-tight first:mt-0">
					{inner}
				</h2>
			);
		case "h3":
			return (
				<h3 key={key} className="mt-4 text-lg font-semibold first:mt-0">
					{inner}
				</h3>
			);
		case "p":
			return (
				<p key={key} className="my-3 leading-7 first:mt-0">
					{inner}
				</p>
			);
		case "a":
			return (
				<p key={key} className="my-3 leading-7 first:mt-0">
					{renderInline([node], `b-${key}`)}
				</p>
			);
		default:
			break;
	}
	if (hasOnlyInlineChildren(node)) {
		return (
			<p key={key} className="my-3 leading-7 first:mt-0">
				{inner}
			</p>
		);
	}
	// Unknown block-level element: render each child as its own block.
	return (node.children ?? [])
		.filter((child): child is RichTextNode => !!child && typeof child === "object")
		.map((child, i) => renderBlock(child, i));
};

/** Render a stored Plate value. Invalid/empty input renders an empty
 * container — callers treat `null` content the same as the canonical
 * empty document. */
export function RichTextView({ value }: { value: unknown }) {
	const nodes = (Array.isArray(value) ? value : []) as RichTextNode[];
	const blocks: ReactNode[] = [];
	let index = 0;
	let key = 0;
	while (index < nodes.length) {
		const node = nodes[index];
		if (isListItem(node)) {
			const run: RichTextNode[] = [];
			while (index < nodes.length && isListItem(nodes[index])) {
				run.push(nodes[index]!);
				index += 1;
			}
			blocks.push(
				<Fragment key={key++}>{buildListRun(run).map((list, i) => renderList(list, i))}</Fragment>,
			);
		} else {
			blocks.push(renderBlock(node, key++));
			index += 1;
		}
	}
	return <div>{blocks}</div>;
}
