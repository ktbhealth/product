import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
	Handle,
	MarkerType,
	Position,
	type Connection,
	type Edge,
	type Node as FlowNode,
	type NodeChange,
	type NodeProps,
} from "@xyflow/react";
import { ArrowLeftIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { JsonObject, OrchestrationDef, OrchestrationNode } from "@ktb/orchestrator";
import { Canvas } from "@ktbhealth/ui/components/ai-elements/canvas";
import { Controls } from "@ktbhealth/ui/components/ai-elements/controls";
import {
	Node,
	NodeContent,
	NodeHeader,
	NodeTitle,
} from "@ktbhealth/ui/components/ai-elements/node";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Spinner } from "@ktbhealth/ui/components/spinner";
import { Switch } from "@ktbhealth/ui/components/switch";
import { Textarea } from "@ktbhealth/ui/components/textarea";
import { cn } from "@ktbhealth/ui/lib/utils";

import { upsertOrchestrationFn } from "../fns.ts";
import {
	addNode,
	connectNodes,
	deriveGraph,
	nextNodeId,
	ORCHESTRATOR_NODE_ID,
	removeNode,
	suggestEventType,
	updateNode,
	type DerivedNode,
} from "../graph.ts";
import { I18N_NAMESPACE, pipelineMessages, type PipelineMessages } from "../i18n.ts";

export interface OrchestrationEditorPageProps {
	/** "new" renders an empty def; "edit" hydrates from `def`. */
	readonly mode: "new" | "edit";
	/** Stored def for edit mode (null → treated as missing). */
	readonly def: OrchestrationDef | null;
	/** Kind ids offered by the palette (server fn / loader). */
	readonly kinds: readonly string[];
	readonly i18n?: PageI18nSlice;
	readonly locale?: string;
}

const EDITOR_BASE = "/platform/pipelines";

const asObject = (value: unknown): JsonObject =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

const parseList = (text: string): string[] =>
	text
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");

const DEFAULT_POSITIONS = { x: 40, y: 40 };
const NODE_DX = 260;
const NODE_DY = 140;

interface FlowNodeData extends Record<string, unknown> {
	readonly node: DerivedNode;
}

type OrchFlowNode = FlowNode<FlowNodeData, "orch">;

/** Canvas node: id + kind header, on/emits chips. The orchestrator
 * pseudo-node renders dashed — it is derived, never authored. */
function OrchNodeView({ data, selected }: NodeProps<OrchFlowNode>) {
	const pseudo = data.node.pseudo;
	return (
		<Node
			handles={{ target: false, source: false }}
			className={cn("w-52", pseudo && "border-dashed opacity-80", selected && "ring-2 ring-ring")}
		>
			{!pseudo ? <Handle type="target" position={Position.Top} /> : null}
			{!pseudo ? <Handle type="source" position={Position.Bottom} /> : null}
			<NodeHeader className="flex-row items-center gap-2">
				<NodeTitle className="truncate text-xs">{data.node.id}</NodeTitle>
				<Badge variant={pseudo ? "outline" : "secondary"} className="ml-auto text-[10px]">
					{data.node.kind}
				</Badge>
			</NodeHeader>
			<NodeContent className="py-2">
				<div className="flex flex-wrap gap-1">
					{data.node.on.slice(0, 4).map((type) => (
						<Badge key={`on-${type}`} variant="outline" className="font-mono text-[10px]">
							on:{type}
						</Badge>
					))}
					{data.node.on.length > 4 ? (
						<span className="text-[10px] text-muted-foreground">+{data.node.on.length - 4}</span>
					) : null}
					{data.node.emits.slice(0, 4).map((type) => (
						<Badge key={`em-${type}`} variant="secondary" className="font-mono text-[10px]">
							→{type}
						</Badge>
					))}
				</div>
			</NodeContent>
		</Node>
	);
}

const nodeTypes = { orch: OrchNodeView };

/** Comma-separated event-type list editor — `on`/`emits` are plain
 * string arrays on the node. */
function TypeListField({
	label,
	value,
	onChange,
}: {
	readonly label: string;
	readonly value: readonly string[];
	readonly onChange: (next: string[]) => void;
}) {
	return (
		<div className="space-y-1">
			<Label className="text-xs">{label}</Label>
			<Input
				value={value.join(", ")}
				onChange={(e) => onChange(parseList(e.target.value))}
				className="font-mono text-xs"
			/>
		</div>
	);
}

/** Kind-aware params editor. `ai`/`gate` get structured fields (the
 * shapes `builtinKinds` document); `emit` and unknown kinds fall back
 * to a raw-JSON draft with an explicit Apply — a malformed draft must
 * never reach the def silently. */
function ParamsEditor({
	node,
	t,
	onPatch,
}: {
	readonly node: OrchestrationNode;
	readonly t: PipelineMessages;
	readonly onPatch: (patch: Partial<OrchestrationNode>) => void;
}) {
	const params = asObject(node.params);
	const setParam = (key: string, value: unknown) =>
		// Object.assign, not spread: JsonObject is an effect Schema type
		// and object-spread trips no-misused-spread on it.
		onPatch({ params: Object.assign({}, params, { [key]: value }) as JsonObject });

	if (node.kind === "ai") {
		return (
			<div className="space-y-2">
				<div className="space-y-1">
					<Label className="text-xs">{t.kindAiTemplate}</Label>
					<Input
						value={asString(params["template"])}
						onChange={(e) => setParam("template", e.target.value)}
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-xs">{t.kindAiModel}</Label>
					<Input
						value={asString(params["model"])}
						onChange={(e) => setParam("model", e.target.value)}
					/>
				</div>
				<label className="flex items-center gap-2 text-xs">
					<Switch
						checked={params["echo"] === true}
						onCheckedChange={(checked) => setParam("echo", checked)}
					/>
					{t.kindAiEcho}
				</label>
			</div>
		);
	}

	if (node.kind === "gate") {
		const when = asObject(params["when"]);
		const setWhen = (key: string, value: unknown) =>
			setParam("when", Object.assign({}, when, { [key]: value }));
		return (
			<div className="space-y-2">
				<div className="space-y-1">
					<Label className="text-xs">{t.kindGatePath}</Label>
					<Input
						value={asString(when["path"])}
						onChange={(e) => setWhen("path", e.target.value)}
						className="font-mono text-xs"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-xs">{t.kindGateEquals}</Label>
					<Input
						defaultValue={JSON.stringify(when["equals"] ?? "")}
						onBlur={(e) => {
							const raw = e.target.value;
							try {
								setWhen("equals", JSON.parse(raw) as unknown);
							} catch {
								setWhen("equals", raw);
							}
						}}
						className="font-mono text-xs"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-xs">{t.kindGatePassEvent}</Label>
					<Input
						value={asString(params["passEvent"]) || "gate.pass"}
						onChange={(e) => setParam("passEvent", e.target.value)}
						className="font-mono text-xs"
					/>
				</div>
				<div className="space-y-1">
					<Label className="text-xs">{t.kindGateFailEvent}</Label>
					<Input
						value={asString(params["failEvent"]) || "gate.fail"}
						onChange={(e) => setParam("failEvent", e.target.value)}
						className="font-mono text-xs"
					/>
				</div>
			</div>
		);
	}

	// `emit` params are `{events: [...]}` — the editor works on the
	// array itself and re-wraps on Apply. Everything else edits the
	// whole params object.
	const arrayMode = node.kind === "emit";
	return (
		<JsonParamsEditor key={node.id} node={node} t={t} arrayMode={arrayMode} onPatch={onPatch} />
	);
}

function JsonParamsEditor({
	node,
	t,
	arrayMode,
	onPatch,
}: {
	readonly node: OrchestrationNode;
	readonly t: PipelineMessages;
	readonly arrayMode: boolean;
	readonly onPatch: (patch: Partial<OrchestrationNode>) => void;
}) {
	const params = asObject(node.params);
	const [draft, setDraft] = useState(() =>
		arrayMode
			? JSON.stringify(Array.isArray(params["events"]) ? params["events"] : [], null, 2)
			: JSON.stringify(node.params ?? {}, null, 2),
	);
	const [invalid, setInvalid] = useState(false);
	return (
		<div className="space-y-1">
			<Label className="text-xs">{arrayMode ? t.kindEmitEvents : t.nodeParamsJson}</Label>
			<Textarea
				value={draft}
				onChange={(e) => {
					setDraft(e.target.value);
					setInvalid(false);
				}}
				className="min-h-28 font-mono text-xs"
			/>
			{invalid ? <p className="text-xs text-destructive">{t.nodeParamsInvalid}</p> : null}
			<Button
				type="button"
				size="sm"
				variant="secondary"
				onClick={() => {
					try {
						const parsed: unknown = JSON.parse(draft);
						if (arrayMode) {
							if (!Array.isArray(parsed)) {
								setInvalid(true);
								return;
							}
							onPatch({
								params: Object.assign({}, params, { events: parsed }) as JsonObject,
							});
						} else {
							if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
								setInvalid(true);
								return;
							}
							onPatch({ params: parsed as JsonObject });
						}
						setInvalid(false);
					} catch {
						setInvalid(true);
					}
				}}
			>
				{t.applyParams}
			</Button>
		</div>
	);
}

/**
 * /platform/pipelines/<id|new> (P-120 phase 4): the orchestration-def
 * editor. The canvas DERIVES edges — `emits ∩ on` between nodes, plus
 * lifecycle edges from the orchestrator pseudo-node — and the connect
 * gesture writes the shared event type back into both nodes' `emits`/
 * `on`. The def is the source of truth; node positions are ephemeral
 * canvas state (the def schema has no layout slot).
 */
export function OrchestrationEditorPage({
	mode,
	def: initialDef,
	kinds,
	i18n,
	locale,
}: OrchestrationEditorPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, pipelineMessages(locale));
	const [def, setDef] = useState<OrchestrationDef>(
		() =>
			initialDef ?? {
				id: "",
				version: "1",
				nodes: [],
			},
	);
	const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [pendingConnect, setPendingConnect] = useState<Connection | null>(null);
	const [connectType, setConnectType] = useState("");
	const [busy, setBusy] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveFailed, setSaveFailed] = useState(false);

	const graph = useMemo(() => deriveGraph(def), [def]);
	const selectedNode = def.nodes.find((n) => n.id === selectedId);

	const flowNodes = useMemo<OrchFlowNode[]>(
		() =>
			graph.nodes.map((node, index) => {
				const position = positions[node.id] ?? {
					x: DEFAULT_POSITIONS.x + (index % 4) * NODE_DX,
					y: DEFAULT_POSITIONS.y + Math.floor(index / 4) * NODE_DY,
				};
				return {
					id: node.id,
					type: "orch",
					position,
					data: { node },
				} as OrchFlowNode;
			}),
		[graph.nodes, positions],
	);

	const flowEdges = useMemo<Edge[]>(
		() =>
			graph.edges.map((edge) => ({
				id: edge.id,
				source: edge.source,
				target: edge.target,
				label: edge.eventTypes.length <= 2 ? edge.eventTypes.join(", ") : undefined,
				markerEnd: { type: MarkerType.ArrowClosed },
			})),
		[graph.edges],
	);

	// Canvas is the untyped ReactFlow wrapper — changes arrive as the
	// base `Node` change union; only `position` deltas are consumed.
	const onNodesChange = (changes: NodeChange<FlowNode>[]) => {
		setPositions((prev) => {
			const next = { ...prev };
			for (const change of changes) {
				if (change.type === "position" && change.position !== undefined) {
					next[change.id] = change.position;
				}
			}
			return next;
		});
	};

	const addKindNode = (kind: string) => {
		const node: OrchestrationNode = {
			id: nextNodeId(def, kind),
			kind,
			on: ["start"],
			emits: [],
		};
		setDef((d) => addNode(d, node));
		setPositions((prev) => ({
			...prev,
			[node.id]: {
				x: DEFAULT_POSITIONS.x + def.nodes.length * 40,
				y: DEFAULT_POSITIONS.y + def.nodes.length * 60,
			},
		}));
		setSelectedId(node.id);
	};

	const patchNode = (nodeId: string, patch: Partial<OrchestrationNode>) =>
		setDef((d) => updateNode(d, nodeId, patch));

	const confirmConnect = () => {
		if (
			pendingConnect?.source != null &&
			pendingConnect.target != null &&
			connectType.trim() !== ""
		) {
			setDef((d) =>
				connectNodes(d, pendingConnect.source, pendingConnect.target, connectType.trim()),
			);
		}
		setPendingConnect(null);
		setConnectType("");
	};

	const save = async () => {
		setBusy(true);
		setSaved(false);
		setSaveFailed(false);
		try {
			const result = await upsertOrchestrationFn({ data: def });
			if (result === false) {
				setSaveFailed(true);
			} else {
				setSaved(true);
			}
		} catch {
			setSaveFailed(true);
		} finally {
			setBusy(false);
		}
	};

	const missing = mode === "edit" && initialDef === null;
	if (missing) {
		return (
			<div className="space-y-3 p-6">
				<p className="text-sm text-muted-foreground">{t.editorMissing}</p>
				<Button
					nativeButton={false}
					variant="secondary"
					size="sm"
					render={<Link to={EDITOR_BASE} />}
				>
					{t.backToList}
				</Button>
			</div>
		);
	}

	return (
		<div className="space-y-4 p-6">
			<div className="flex items-center gap-3">
				<Button nativeButton={false} variant="ghost" size="sm" render={<Link to={EDITOR_BASE} />}>
					<ArrowLeftIcon className="size-4" />
					{t.backToList}
				</Button>
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-lg font-semibold">
						{mode === "new" ? t.editorNewTitle : t.editorEditTitle(def.id)}
					</h1>
				</div>
				{saved ? <span className="text-sm text-muted-foreground">{t.saved}</span> : null}
				{saveFailed ? <span className="text-sm text-destructive">{t.saveFailed}</span> : null}
				<Button size="sm" onClick={() => void save()} disabled={busy || def.id.trim() === ""}>
					{busy ? <Spinner className="size-4" /> : null}
					{t.save}
				</Button>
			</div>

			<div className="grid gap-4 lg:grid-cols-[16rem_1fr_20rem]">
				{/* Node palette */}
				<aside className="space-y-2 rounded-md border p-3">
					<h2 className="text-sm font-medium">{t.paletteTitle}</h2>
					<p className="text-xs text-muted-foreground">{t.paletteHint}</p>
					<div className="flex flex-col gap-1">
						{kinds.length === 0 ? (
							<p className="text-xs text-muted-foreground">{t.kindsLoading}</p>
						) : (
							kinds.map((kind) => (
								<Button
									key={kind}
									type="button"
									variant="outline"
									size="sm"
									className="justify-start font-mono text-xs"
									onClick={() => addKindNode(kind)}
								>
									<PlusIcon className="size-3.5" />
									{kind}
								</Button>
							))
						)}
					</div>
				</aside>

				{/* Canvas */}
				<div className="relative h-[65vh] overflow-hidden rounded-md border">
					<Canvas
						nodes={flowNodes}
						edges={flowEdges}
						nodeTypes={nodeTypes}
						onNodesChange={onNodesChange}
						onConnect={(connection) => {
							setPendingConnect(connection);
							setConnectType(
								suggestEventType(def, connection.source ?? "", connection.target ?? ""),
							);
						}}
						onNodeClick={(_, node) => {
							if (node.id !== ORCHESTRATOR_NODE_ID) setSelectedId(node.id);
						}}
						onPaneClick={() => setSelectedId(null)}
						connectionLineStyle={{ stroke: "var(--muted-foreground)", strokeDasharray: 4 }}
					>
						<Controls position="bottom-right" />
					</Canvas>
				</div>

				{/* Inspector */}
				<aside className="space-y-4 rounded-md border p-3">
					{selectedNode === undefined ? (
						<p className="text-sm text-muted-foreground">{t.selectNodeHint}</p>
					) : (
						<div className="space-y-4">
							<h2 className="text-sm font-medium">{t.nodeSection}</h2>
							<div className="space-y-1">
								<Label className="text-xs">{t.nodeId}</Label>
								<Input
									value={selectedNode.id}
									onChange={(e) => patchNode(selectedNode.id, { id: e.target.value })}
									className="font-mono text-xs"
								/>
							</div>
							<div className="space-y-1">
								<Label className="text-xs">{t.nodeKind}</Label>
								<Select
									items={[
										...kinds.map((kind) => ({ value: kind, label: kind })),
										// A stored def may name a kind the palette no
										// longer offers — keep it selectable.
										...(kinds.includes(selectedNode.kind)
											? []
											: [{ value: selectedNode.kind, label: selectedNode.kind }]),
									]}
									value={selectedNode.kind}
									onValueChange={(value) =>
										patchNode(selectedNode.id, {
											kind: String(value),
											params: {},
										})
									}
								>
									<SelectTrigger size="sm" className="w-full font-mono text-xs">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{[
											...kinds,
											...(kinds.includes(selectedNode.kind) ? [] : [selectedNode.kind]),
										].map((kind) => (
											<SelectItem key={kind} value={kind}>
												{kind}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							<TypeListField
								label={t.nodeOn}
								value={selectedNode.on}
								onChange={(on) => patchNode(selectedNode.id, { on })}
							/>
							<TypeListField
								label={t.nodeEmits}
								value={selectedNode.emits}
								onChange={(emits) => patchNode(selectedNode.id, { emits })}
							/>
							<ParamsEditor
								node={selectedNode}
								t={t}
								onPatch={(patch) => patchNode(selectedNode.id, patch)}
							/>
							<Button
								type="button"
								variant="destructive"
								size="sm"
								onClick={() => {
									setDef((d) => removeNode(d, selectedNode.id));
									setSelectedId(null);
								}}
							>
								<Trash2Icon className="size-4" />
								{t.deleteNode}
							</Button>
						</div>
					)}
				</aside>
			</div>

			{/* Def-level fields */}
			<details className="rounded-md border p-3">
				<summary className="cursor-pointer text-sm font-medium">{t.defSection}</summary>
				<div className="mt-3 grid gap-3 sm:grid-cols-2">
					<div className="space-y-1">
						<Label className="text-xs">{t.defId}</Label>
						<Input
							value={def.id}
							onChange={(e) => setDef((d) => ({ ...d, id: e.target.value }))}
							disabled={mode === "edit"}
							className="font-mono text-xs"
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">{t.defVersion}</Label>
						<Input
							value={def.version ?? ""}
							onChange={(e) =>
								setDef((d) => ({
									...d,
									version: e.target.value === "" ? undefined : e.target.value,
								}))
							}
							className="font-mono text-xs"
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">{t.defDescription}</Label>
						<Input
							value={def.description ?? ""}
							onChange={(e) =>
								setDef((d) => ({
									...d,
									description: e.target.value === "" ? undefined : e.target.value,
								}))
							}
						/>
					</div>
					<div className="space-y-1">
						<Label className="text-xs">{t.onNodeError}</Label>
						<Select
							items={[
								{ value: "halt", label: t.onNodeErrorHalt },
								{ value: "continue", label: t.onNodeErrorContinue },
							]}
							value={def.onNodeError ?? "halt"}
							onValueChange={(value) =>
								setDef((d) => ({
									...d,
									onNodeError: value === "continue" ? "continue" : "halt",
								}))
							}
						>
							<SelectTrigger size="sm" className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="halt">{t.onNodeErrorHalt}</SelectItem>
								<SelectItem value="continue">{t.onNodeErrorContinue}</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
			</details>

			{/* Connect dialog — the gesture writes the shared event type
			 * into source.emits + target.on on confirm. */}
			<Dialog
				open={pendingConnect !== null}
				onOpenChange={(open) => {
					if (!open) {
						setPendingConnect(null);
						setConnectType("");
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t.connectTitle}</DialogTitle>
					</DialogHeader>
					<div className="space-y-1">
						<Label className="text-xs">{t.connectEventType}</Label>
						<Input
							value={connectType}
							onChange={(e) => setConnectType(e.target.value)}
							className="font-mono text-xs"
						/>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => {
								setPendingConnect(null);
								setConnectType("");
							}}
						>
							<XIcon className="size-4" />
							{t.cancel}
						</Button>
						<Button type="button" size="sm" onClick={confirmConnect}>
							{t.connectConfirm}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
