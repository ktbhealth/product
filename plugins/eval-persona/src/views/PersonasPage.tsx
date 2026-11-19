import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PencilIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import { Textarea } from "@ktbhealth/ui/components/textarea";

import type { EndpointCard } from "@ktb/ai-provider";
import { listEndpointsFn } from "@ktb/ai-provider/fns";

import {
	deletePersonaDefFn,
	generatePersonasFn,
	listPersonaDefsFn,
	savePersonaDefFn,
} from "../fns.ts";
import { evalLabMessages, I18N_NAMESPACE } from "../i18n.ts";
import { EvalSteps } from "../steps.tsx";
import type { PersonaDefCard } from "../index.ts";

const GEN_TEMPLATE = "__template__";
const GEN_COUNTS = [5, 10, 20] as const;

const AGE_BANDS = ["child", "adult", "elderly"] as const;
const CLASSES = ["low", "middle", "high"] as const;
const EDUCATION = ["primary", "secondary", "higher"] as const;
const REGIONS = ["north", "northeast", "central", "southeast", "south"] as const;
const REGISTERS = ["colloquial", "neutral", "technical"] as const;
const SPECIALTIES = ["general_practice", "cardiology", "dermatology", "pediatrics"] as const;
const GENDERS = ["female", "male"] as const;

type FormState = {
	id: number | null;
	name: string;
	patientName: string;
	gender: string;
	ageBand: string;
	socialClass: string;
	education: string;
	region: string;
	register: string;
	specialty: string;
	doctorGender: string;
	doctorRegister: string;
	notes: string;
};

const EMPTY: FormState = {
	id: null,
	name: "",
	patientName: "",
	gender: "female",
	ageBand: "adult",
	socialClass: "middle",
	education: "secondary",
	region: "southeast",
	register: "colloquial",
	specialty: "general_practice",
	doctorGender: "female",
	doctorRegister: "neutral",
	notes: "",
};

const fromCard = (d: PersonaDefCard): FormState => ({
	id: d.id,
	name: d.name,
	patientName: d.persona.name ?? "",
	gender: d.persona.gender === "m" ? "male" : "female",
	ageBand: d.persona.ageBand ?? "adult",
	socialClass: d.persona.socialClass ?? "middle",
	education: d.persona.education ?? "secondary",
	region: d.persona.region ?? "southeast",
	register: d.persona.register ?? "colloquial",
	specialty: d.persona.specialty ?? "general_practice",
	doctorGender: d.persona.doctor?.gender === "m" ? "male" : "female",
	doctorRegister: d.persona.doctor?.register ?? "neutral",
	notes: d.notes ?? "",
});

const AxisSelect = ({
	label,
	value,
	options,
	labels,
	onChange,
}: {
	label: string;
	value: string;
	options: readonly string[];
	labels: Record<string, string>;
	onChange: (v: string) => void;
}) => (
	<Field>
		<FieldLabel>{label}</FieldLabel>
		<Select value={value} onValueChange={(v) => onChange(String(v))}>
			<SelectTrigger aria-label={label}>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{options.map((o) => {
					/* v8 ignore next -- every caller passes complete label maps */
					const text = labels[o] ?? o;
					return (
						<SelectItem key={o} value={o}>
							{text}
						</SelectItem>
					);
				})}
			</SelectContent>
		</Select>
	</Field>
);

const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)]!;

const randomizeForm = (base: FormState): FormState => ({
	...base,
	gender: pick(GENDERS),
	ageBand: pick(AGE_BANDS),
	socialClass: pick(CLASSES),
	education: pick(EDUCATION),
	region: pick(REGIONS),
	register: pick(REGISTERS),
	specialty: pick(SPECIALTIES),
	doctorGender: pick(GENDERS),
	doctorRegister: pick(REGISTERS),
});

/** /platform/eval/personas view: CRUD of curated persona definitions —
 * the eval setup surface. Synthetic entities get created later, at
 * instance generation time. */
export function PersonasPage({
	defs: initial,
	i18n,
	locale,
}: {
	defs: readonly PersonaDefCard[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	locale: string;
}) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, evalLabMessages(locale));
	const router = useRouter();
	const [defs, setDefs] = useState<readonly PersonaDefCard[]>(initial);
	const [form, setForm] = useState<FormState | null>(null);
	const [gen, setGen] = useState<{ endpointId: string; count: number } | null>(null);
	const [genEndpoints, setGenEndpoints] = useState<readonly EndpointCard[]>([]);
	const [confirmId, setConfirmId] = useState<number | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const refresh = async () => {
		const r = await listPersonaDefsFn();
		if (r.ok) setDefs(r.data);
		void router.invalidate();
	};

	// Endpoints load lazily — the generate dialog is the only surface
	// that needs them, so the page loader stays untouched.
	const openGenerate = async () => {
		setGen({ endpointId: GEN_TEMPLATE, count: 10 });
		const r = await listEndpointsFn();
		if (r.ok) setGenEndpoints(r.data);
	};

	const runGenerate = async () => {
		/* v8 ignore next -- the dialog only renders when gen is set */
		if (gen === null) return;
		setBusy(true);
		setError(null);
		const r = await generatePersonasFn({
			data: {
				count: gen.count,
				...(gen.endpointId !== GEN_TEMPLATE ? { endpointId: Number(gen.endpointId) } : {}),
			},
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setGen(null);
		setNotice(m.genDone);
		await refresh();
	};

	const save = async () => {
		/* v8 ignore next -- the dialog only renders when form is set */
		if (form === null) return;
		setBusy(true);
		setError(null);
		const r = await savePersonaDefFn({
			data: {
				...(form.id !== null ? { id: form.id } : {}),
				name: form.name,
				patientName: form.patientName,
				gender: form.gender,
				ageBand: form.ageBand,
				socialClass: form.socialClass,
				education: form.education,
				region: form.region,
				register: form.register,
				specialty: form.specialty,
				doctorGender: form.doctorGender,
				doctorRegister: form.doctorRegister,
				...(form.notes !== "" ? { notes: form.notes } : {}),
			},
		});
		setBusy(false);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		setForm(null);
		await refresh();
	};

	const remove = async (id: number) => {
		setBusy(true);
		setError(null);
		const r = await deletePersonaDefFn({ data: { id } });
		setBusy(false);
		setConfirmId(null);
		if (!r.ok) {
			setError(m.actionFailed);
			return;
		}
		await refresh();
	};

	const axes = (d: PersonaDefCard) =>
		[d.persona.region, d.persona.ageBand, d.persona.register, d.persona.specialty]
			.filter(Boolean)
			.join(" · ");

	return (
		<PageContainer>
			<EvalSteps
				active={1}
				labels={[m.stepPersonas, m.stepGenerate, m.stepRunEval]}
				ariaLabel={m.pipelineAria}
			/>
			<PageHeader title={m.personasTitle} description={m.personasDesc} />
			<div className="mb-4 flex justify-end gap-2">
				<Button variant="outline" onClick={() => void openGenerate()}>
					<SparklesIcon className="mr-1 size-4" />
					{m.generatePersonas}
				</Button>
				<Button onClick={() => setForm({ ...EMPTY })}>
					<PlusIcon className="mr-1 size-4" />
					{m.newPersona}
				</Button>
			</div>
			{error !== null && <p className="mb-3 text-sm text-destructive">{error}</p>}
			{notice !== null && <p className="mb-3 text-sm text-muted-foreground">{notice}</p>}
			{defs.length === 0 ? (
				<Empty>
					<EmptyHeader>
						<EmptyTitle>{m.personasTitle}</EmptyTitle>
						<EmptyDescription>{m.emptyDefs}</EmptyDescription>
					</EmptyHeader>
				</Empty>
			) : (
				<div className="grid gap-3">
					{defs.map((d) => (
						<Card key={d.id}>
							<CardContent className="flex items-center justify-between gap-4 py-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="font-medium">{d.name}</span>
										<Badge variant="outline">{d.persona.name ?? "—"}</Badge>
									</div>
									<p className="mt-1 truncate text-sm text-muted-foreground">{axes(d)}</p>
									{d.notes !== null && (
										<p className="mt-1 truncate text-xs text-muted-foreground">{d.notes}</p>
									)}
								</div>
								<div className="flex shrink-0 gap-2">
									<Button variant="outline" size="sm" onClick={() => setForm(fromCard(d))}>
										<PencilIcon className="mr-1 size-3" />
										{m.edit}
									</Button>
									{confirmId === d.id ? (
										<Button
											variant="destructive"
											size="sm"
											disabled={busy}
											onClick={() => void remove(d.id)}
										>
											{m.confirmDelete}
										</Button>
									) : (
										<Button
											variant="outline"
											size="sm"
											disabled={busy}
											onClick={() => setConfirmId(d.id)}
										>
											<Trash2Icon className="mr-1 size-3" />
											{m.delete}
										</Button>
									)}
								</div>
							</CardContent>
						</Card>
					))}
				</div>
			)}

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
					<DialogHeader>
						<DialogTitle>
							{form?.id !== null && form?.id !== undefined ? m.edit : m.newPersona}
						</DialogTitle>
					</DialogHeader>
					{form !== null && (
						<div className="grid gap-3">
							<p className="text-xs text-muted-foreground">{m.personaPurpose}</p>
							<Field>
								<FieldLabel>{m.name}</FieldLabel>
								<Input
									value={form.name}
									onChange={(e) => setForm({ ...form, name: e.target.value })}
								/>
							</Field>
							<div className="flex items-center justify-between border-t pt-2">
								<span className="text-xs font-medium text-muted-foreground">
									{m.patientSection}
								</span>
								<Button
									size="sm"
									variant="ghost"
									className="h-6 px-2 text-xs"
									onClick={() => setForm(randomizeForm(form))}
								>
									{m.randomize}
								</Button>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<Field>
									<FieldLabel>{m.patient}</FieldLabel>
									<Input
										value={form.patientName}
										onChange={(e) => setForm({ ...form, patientName: e.target.value })}
									/>
								</Field>
								<AxisSelect
									label={m.gender}
									value={form.gender}
									options={GENDERS}
									labels={{ female: m.female, male: m.male }}
									onChange={(v) => setForm({ ...form, gender: v })}
								/>
							</div>
							<div className="grid grid-cols-2 gap-3">
								<AxisSelect
									label={m.ageBand}
									value={form.ageBand}
									options={AGE_BANDS}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, ageBand: v })}
								/>
								<AxisSelect
									label={m.socialClass}
									value={form.socialClass}
									options={CLASSES}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, socialClass: v })}
								/>
								<AxisSelect
									label={m.education}
									value={form.education}
									options={EDUCATION}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, education: v })}
								/>
								<AxisSelect
									label={m.region}
									value={form.region}
									options={REGIONS}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, region: v })}
								/>
								<AxisSelect
									label={m.register}
									value={form.register}
									options={REGISTERS}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, register: v })}
								/>
								<AxisSelect
									label={m.specialty}
									value={form.specialty}
									options={SPECIALTIES}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, specialty: v })}
								/>
								<AxisSelect
									label={m.doctorGender}
									value={form.doctorGender}
									options={GENDERS}
									labels={{ female: m.female, male: m.male }}
									onChange={(v) => setForm({ ...form, doctorGender: v })}
								/>
								<AxisSelect
									label={m.doctorRegister}
									value={form.doctorRegister}
									options={REGISTERS}
									labels={m.axisLabels}
									onChange={(v) => setForm({ ...form, doctorRegister: v })}
								/>
							</div>
							<Field>
								<FieldLabel>{m.notes}</FieldLabel>
								<Textarea
									value={form.notes}
									onChange={(e) => setForm({ ...form, notes: e.target.value })}
								/>
							</Field>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setForm(null)}>
							{m.cancel}
						</Button>
						<Button
							disabled={busy || form === null || form.name === "" || form.patientName === ""}
							onClick={() => void save()}
						>
							{m.save}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog open={gen !== null} onOpenChange={(open) => !open && setGen(null)}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{m.generatePersonas}</DialogTitle>
					</DialogHeader>
					{gen !== null && (
						<div className="grid gap-3">
							<p className="text-xs text-muted-foreground">{m.genHint}</p>
							<Field>
								<FieldLabel>{m.endpoint}</FieldLabel>
								<Select
									value={gen.endpointId}
									onValueChange={(v) => setGen({ ...gen, endpointId: String(v) })}
								>
									<SelectTrigger aria-label={m.endpoint}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value={GEN_TEMPLATE}>{m.endpointTemplate}</SelectItem>
										{genEndpoints
											.filter((e) => e.enabled && e.scope === "eval")
											.map((e) => (
												<SelectItem key={e.id} value={String(e.id)}>
													{e.name} · {e.model ?? e.kind}
												</SelectItem>
											))}
									</SelectContent>
								</Select>
							</Field>
							<Field>
								<FieldLabel>{m.count}</FieldLabel>
								<div className="flex gap-2">
									{GEN_COUNTS.map((c) => (
										<Button
											key={c}
											type="button"
											size="sm"
											variant={gen.count === c ? "default" : "outline"}
											onClick={() => setGen({ ...gen, count: c })}
										>
											{c}
										</Button>
									))}
								</div>
							</Field>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setGen(null)}>
							{m.cancel}
						</Button>
						<Button disabled={busy || gen === null} onClick={() => void runGenerate()}>
							{m.start}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</PageContainer>
	);
}
