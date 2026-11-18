import { useMemo, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { WizardDefinition } from "../definition.ts";
import {
	adminDeleteWizardDefFn,
	adminSaveWizardDefFn,
	adminSetWizardPublishedFn,
	type WizardDefWire,
} from "../fns.ts";
import { I18N_NAMESPACE, wizardsMessages } from "../i18n.ts";

import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import { Checkbox } from "@ktbhealth/ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ktbhealth/ui/components/alert-dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { PageContainer } from "@ktbhealth/ui/components/page-container";
import { PageHeader } from "@ktbhealth/ui/components/page-header";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Textarea } from "@ktbhealth/ui/components/textarea";

export interface WizardsAdminPageProps {
	/** DB-authored definitions from the panel loader (drafts included). */
	readonly defs: readonly WizardDefWire[];
	/** Code-contributed defs collected from the client registry —
	 * listed read-only for discoverability. */
	readonly codeDefs: readonly WizardDefinition[];
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
}

interface FormState {
	readonly key: string;
	readonly title: string;
	readonly description: string;
	readonly definitionJson: string;
	readonly published: boolean;
}

const EMPTY_FORM: FormState = {
	key: "",
	title: "",
	description: "",
	definitionJson: '{\n\t"id": "",\n\t"steps": []\n}\n',
	published: false,
};

const formFrom = (row: WizardDefWire): FormState => ({
	key: row.key,
	title: row.title,
	description: row.description,
	definitionJson: JSON.stringify(row.definition, null, "\t"),
	published: row.published,
});

/**
 * /platform/wizards console view: list + JSON editor + publish toggle
 * over the `wizard_defs` table. Code-contributed `wizard.def` entries
 * are listed read-only — they are managed in plugin source, not here.
 * Mutations go through the admin-gated server fns; the loader re-runs
 * via `router.invalidate()` after each write.
 */
export function WizardsAdminPage({ defs, codeDefs, i18n, locale }: WizardsAdminPageProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, wizardsMessages(locale));
	const router = useRouter();
	const [form, setForm] = useState<FormState | null>(null);
	const [deleteTarget, setDeleteTarget] = useState<WizardDefWire | null>(null);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [notice, setNotice] = useState<string | null>(null);

	// Code defs shadowed by a DB row of the same key still list — the
	// DB row is authoritative at run time, so mark the overlap.
	const dbKeys = useMemo(() => new Set(defs.map((d) => d.key)), [defs]);
	const shadowed = useMemo(() => codeDefs.filter((d) => dbKeys.has(d.id)), [codeDefs, dbKeys]);
	const visibleCodeDefs = useMemo(
		() => codeDefs.filter((d) => !dbKeys.has(d.id)),
		[codeDefs, dbKeys],
	);

	const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((f) =>
			f === null
				? /* v8 ignore next -- inputs only exist while the dialog is open */ f
				: { ...f, [key]: value },
		);

	const save = async () => {
		/* v8 ignore next -- the Save button only exists while the dialog
		 * (form !== null) is open */
		if (form === null) return;
		let definition: unknown;
		try {
			definition = JSON.parse(form.definitionJson);
		} catch {
			setFailed(true);
			setNotice(t.invalidJson);
			return;
		}
		setBusy(true);
		setFailed(false);
		setNotice(null);
		try {
			const row = await adminSaveWizardDefFn({
				data: {
					key: form.key,
					title: form.title,
					description: form.description,
					definition,
					published: form.published,
				},
			});
			if (row === null) {
				setFailed(true);
				return;
			}
			setForm(null);
			setNotice(t.saved);
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	};

	const togglePublished = async (row: WizardDefWire) => {
		setBusy(true);
		try {
			await adminSetWizardPublishedFn({ data: { key: row.key, published: !row.published } });
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	};

	const remove = async () => {
		/* v8 ignore next -- remove() is only reachable from the confirm
		 * dialog, which exists only while deleteTarget !== null */
		if (deleteTarget === null) return;
		setBusy(true);
		try {
			await adminDeleteWizardDefFn({ data: { key: deleteTarget.key } });
			setDeleteTarget(null);
			setNotice(t.deleted);
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	};

	return (
		<PageContainer>
			<PageHeader
				title={t.adminTitle}
				description={t.adminDescription}
				actions={<Button onClick={() => setForm(EMPTY_FORM)}>{t.newDef}</Button>}
			/>

			{notice !== null && (
				<p role="status" className="text-sm text-muted-foreground">
					{notice}
				</p>
			)}
			{failed && notice === null && (
				<p role="alert" className="text-sm text-destructive">
					{t.saveFailed}
				</p>
			)}

			<section className="flex flex-col gap-2">
				<h2 className="text-lg font-medium">{t.defsHeading}</h2>
				{defs.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t.emptyDefs}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.fieldKey}</TableHead>
								<TableHead>{t.fieldTitle}</TableHead>
								<TableHead>{t.fieldPublished}</TableHead>
								<TableHead className="text-right">{t.editDef}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{defs.map((row) => (
								<TableRow key={row.key}>
									<TableCell className="font-mono text-xs">{row.key}</TableCell>
									<TableCell>{row.title}</TableCell>
									<TableCell>
										<Badge variant={row.published ? "default" : "secondary"}>
											{row.published ? t.publishedBadge : t.unpublishedBadge}
										</Badge>
									</TableCell>
									<TableCell className="text-right">
										<div className="flex justify-end gap-2">
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={() => setForm(formFrom(row))}
											>
												{t.editDef}
											</Button>
											<Button
												variant="outline"
												size="sm"
												disabled={busy}
												onClick={() => void togglePublished(row)}
											>
												{row.published ? t.unpublishedBadge : t.publishedBadge}
											</Button>
											<Button
												variant="ghost"
												size="sm"
												disabled={busy}
												onClick={() => setDeleteTarget(row)}
											>
												{t.deleteLabel}
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<h2 className="text-lg font-medium">{t.codeDefsHeading}</h2>
				<p className="text-sm text-muted-foreground">{t.codeDefsHint}</p>
				{visibleCodeDefs.length === 0 && shadowed.length === 0 ? (
					<p className="text-sm text-muted-foreground">{t.emptyDefs}</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>{t.fieldKey}</TableHead>
								<TableHead>{t.fieldTitle}</TableHead>
								<TableHead>{t.fieldPublished}</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{visibleCodeDefs.map((def) => (
								<TableRow key={def.id}>
									<TableCell className="font-mono text-xs">{def.id}</TableCell>
									<TableCell>{def.title ?? def.id}</TableCell>
									<TableCell>
										<Badge variant="outline">{def.owner ?? "plugin"}</Badge>
									</TableCell>
								</TableRow>
							))}
							{shadowed.map((def) => (
								<TableRow key={`shadow-${def.id}`} className="opacity-60">
									<TableCell className="font-mono text-xs">{def.id}</TableCell>
									<TableCell>{def.title ?? def.id}</TableCell>
									<TableCell>
										<Badge variant="secondary">{t.unpublishedBadge} · DB</Badge>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</section>

			<Dialog open={form !== null} onOpenChange={(open) => !open && setForm(null)}>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>{form?.key ? form.key : t.newDef}</DialogTitle>
						<DialogDescription>{t.fieldDefinition}</DialogDescription>
					</DialogHeader>
					{form !== null && (
						<div className="flex flex-col gap-3">
							<Field>
								<FieldLabel htmlFor="wiz-key">{t.fieldKey}</FieldLabel>
								<Input id="wiz-key" value={form.key} onChange={(e) => set("key", e.target.value)} />
							</Field>
							<Field>
								<FieldLabel htmlFor="wiz-title">{t.fieldTitle}</FieldLabel>
								<Input
									id="wiz-title"
									value={form.title}
									onChange={(e) => set("title", e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="wiz-desc">{t.fieldDescription}</FieldLabel>
								<Input
									id="wiz-desc"
									value={form.description}
									onChange={(e) => set("description", e.target.value)}
								/>
							</Field>
							<Field>
								<FieldLabel htmlFor="wiz-def">{t.fieldDefinition}</FieldLabel>
								<Textarea
									id="wiz-def"
									className="min-h-64 font-mono text-xs"
									value={form.definitionJson}
									onChange={(e) => set("definitionJson", e.target.value)}
								/>
							</Field>
							<Field orientation="horizontal">
								<Checkbox
									id="wiz-published"
									checked={form.published}
									onCheckedChange={(v) => set("published", v === true)}
								/>
								<FieldLabel htmlFor="wiz-published">{t.fieldPublished}</FieldLabel>
							</Field>
						</div>
					)}
					<DialogFooter>
						<Button variant="outline" onClick={() => setForm(null)}>
							{t.cancel}
						</Button>
						<Button disabled={busy} onClick={() => void save()}>
							{t.save}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={deleteTarget !== null}
				onOpenChange={(open) => !open && setDeleteTarget(null)}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{deleteTarget?.key}</AlertDialogTitle>
						<AlertDialogDescription>{t.confirmDelete}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t.cancel}</AlertDialogCancel>
						<AlertDialogAction disabled={busy} onClick={() => void remove()}>
							{t.deleteLabel}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</PageContainer>
	);
}
