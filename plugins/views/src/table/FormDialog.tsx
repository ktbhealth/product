import { useEffect, useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";
import { Textarea } from "@ktbhealth/ui/components/textarea";

const inputCls =
	"h-8 rounded-md border border-input bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";
const textareaCls =
	"rounded-md border border-input bg-background px-2 py-1.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** One editable row in a {@link FormDialog}. */
export interface FormField {
	/** Key the value is submitted under. */
	name: string;
	label: ReactNode;
	placeholder?: string;
	required?: boolean;
	type?: "text" | "textarea";
}

export interface FormDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: ReactNode;
	description?: ReactNode;
	fields: readonly FormField[];
	submitLabel: ReactNode;
	/** Defaults to "Cancel". */
	cancelLabel?: ReactNode;
	/** External busy override — merged with the internal submitting state. */
	loading?: boolean;
	/** External error line rendered above the footer. */
	error?: ReactNode;
	/**
	 * Receives trimmed values keyed by field name. Return `false` to keep
	 * the dialog open (e.g. the mutation failed); `true`/`void` closes it
	 * and resets the fields.
	 */
	onSubmit: (values: Record<string, string>) => Promise<boolean | void> | boolean | void;
}

/**
 * Fields-driven create/edit dialog for admin tables — generalizes the
 * per-plugin `Create*Dialog` pattern (Dialog + Field rows + DialogFooter)
 * so callers only supply field descriptors and an `onSubmit`.
 */
export function FormDialog({
	open,
	onOpenChange,
	title,
	description,
	fields,
	submitLabel,
	cancelLabel = "Cancel",
	loading = false,
	error,
	onSubmit,
}: FormDialogProps) {
	const [values, setValues] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const busy = submitting || loading;

	// Fresh form each time the dialog opens.
	useEffect(() => {
		if (open) setValues({});
	}, [open]);

	const submit = async (event: FormEvent) => {
		event.preventDefault();
		if (busy) return;
		const trimmed: Record<string, string> = {};
		for (const field of fields) {
			const value = (values[field.name] ?? "").trim();
			if (field.required && value === "") return;
			trimmed[field.name] = value;
		}
		setSubmitting(true);
		try {
			const result = await onSubmit(trimmed);
			if (result !== false) {
				setValues({});
				onOpenChange(false);
			}
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					{description ? <DialogDescription>{description}</DialogDescription> : null}
				</DialogHeader>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						void submit(e);
					}}
				>
					{fields.map((field) => {
						const id = `form-dialog-${field.name}`;
						const value = values[field.name] ?? "";
						const onChange = (e: { target: { value: string } }) =>
							setValues((prev) => ({ ...prev, [field.name]: e.target.value }));
						return (
							<Field key={field.name}>
								<FieldLabel htmlFor={id}>{field.label}</FieldLabel>
								{field.type === "textarea" ? (
									<Textarea
										id={id}
										className={textareaCls}
										rows={3}
										placeholder={field.placeholder}
										required={field.required}
										value={value}
										onChange={onChange}
									/>
								) : (
									<Input
										id={id}
										className={inputCls}
										placeholder={field.placeholder}
										required={field.required}
										value={value}
										onChange={onChange}
									/>
								)}
							</Field>
						);
					})}
					{error ? <p className="text-xs text-destructive">{error}</p> : null}
					<DialogFooter>
						<Button
							type="button"
							variant="ghost"
							size="sm"
							disabled={busy}
							onClick={() => onOpenChange(false)}
						>
							{cancelLabel}
						</Button>
						<Button type="submit" size="sm" disabled={busy}>
							{submitLabel}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
