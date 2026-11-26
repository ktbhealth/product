import { CheckCircle2Icon, MailIcon } from "lucide-react";

import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ktbhealth/ui/components/radio-group";

import type { ConsultationMessages } from "../i18n.ts";

type Nc = ConsultationMessages["newConsultation"];

/** Where the linked patient stands on portal access (T-258). `unknown`
 * means the lookup is unavailable or failed — the save dialog's
 * after-the-fact question stays the fallback then. */
export type AccessStanding =
	| { readonly status: "unknown" }
	| { readonly status: "has-access" }
	| { readonly status: "none"; readonly email: string | null };

/** The doctor's up-front decision; the invite fires on save. */
export interface AccessChoice {
	readonly send: boolean;
	readonly email: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const looksLikeEmail = (email: string) => EMAIL.test(email.trim());

/** Default for a patient without access: send when the record already
 * carries an email, otherwise wait for the doctor to type one. */
export const defaultChoice = (email: string | null): AccessChoice => ({
	send: email !== null && email !== "",
	email: email ?? "",
});

/**
 * "Patient access to this consultation" card under the patient picker:
 * decides before the visit whether the saved consultation reaches the
 * patient portal by email. Renders nothing for an unknown standing.
 */
export function PatientAccessCard({
	patientName,
	standing,
	choice,
	onChange,
	nc,
}: {
	readonly patientName: string;
	readonly standing: AccessStanding;
	readonly choice: AccessChoice;
	readonly onChange: (choice: AccessChoice) => void;
	readonly nc: Nc;
}) {
	if (standing.status === "has-access") {
		return (
			<p className="flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success ring-1 ring-success/20">
				<CheckCircle2Icon className="size-4 shrink-0" />
				{nc.accessCardHasAccess(patientName)}
			</p>
		);
	}
	if (standing.status !== "none") return null;
	const invalid = choice.send && choice.email.trim() !== "" && !looksLikeEmail(choice.email);
	return (
		<section
			aria-labelledby="patient-access-title"
			className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 px-4 py-3"
		>
			<div className="flex items-start gap-3">
				<MailIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				<div>
					<h3 id="patient-access-title" className="text-sm font-semibold">
						{nc.accessCardTitle}
					</h3>
					<p className="text-xs text-muted-foreground">{nc.accessCardNone(patientName)}</p>
				</div>
			</div>
			<RadioGroup
				aria-labelledby="patient-access-title"
				value={choice.send ? "send" : "skip"}
				onValueChange={(v) => onChange({ ...choice, send: v === "send" })}
				className="gap-2 pl-7"
			>
				<Label className="flex items-center gap-2 text-sm font-normal">
					<RadioGroupItem value="send" />
					{nc.accessSendOnSave}
				</Label>
				{choice.send ? (
					<div className="flex flex-col gap-1 pl-6">
						<Input
							type="email"
							autoComplete="off"
							aria-label={nc.accessEmailLabel}
							aria-invalid={invalid || undefined}
							placeholder={nc.accessEmailPlaceholder}
							value={choice.email}
							onChange={(e) => onChange({ ...choice, email: e.target.value })}
							className="max-w-xs"
						/>
						{invalid ? (
							<p className="text-xs text-destructive">{nc.accessInvalidEmail}</p>
						) : (
							<p className="text-xs text-muted-foreground">{nc.accessHint}</p>
						)}
					</div>
				) : null}
				<Label className="flex items-center gap-2 text-sm font-normal">
					<RadioGroupItem value="skip" />
					{nc.accessSkip}
				</Label>
			</RadioGroup>
		</section>
	);
}

/**
 * Quick-create follow-up: once a name is typed, ask whether this new
 * patient gets the consultation by email — "Yes" reveals the address.
 */
export function NewPatientAccessQuestion({
	choice,
	onChange,
	nc,
}: {
	readonly choice: AccessChoice;
	readonly onChange: (choice: AccessChoice) => void;
	readonly nc: Nc;
}) {
	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
			<span id="new-patient-access" className="text-muted-foreground">
				{nc.newPatientAccessQuestion}
			</span>
			<RadioGroup
				aria-labelledby="new-patient-access"
				value={choice.send ? "send" : "skip"}
				onValueChange={(v) => onChange({ ...choice, send: v === "send" })}
				className="flex w-auto gap-3"
			>
				<Label className="flex items-center gap-1.5 text-xs font-normal">
					<RadioGroupItem value="send" />
					{nc.accessYes}
				</Label>
				<Label className="flex items-center gap-1.5 text-xs font-normal">
					<RadioGroupItem value="skip" />
					{nc.accessNo}
				</Label>
			</RadioGroup>
			{choice.send ? (
				<Input
					type="email"
					autoComplete="off"
					aria-label={nc.accessEmailLabel}
					placeholder={nc.accessEmailPlaceholder}
					value={choice.email}
					onChange={(e) => onChange({ ...choice, email: e.target.value })}
					className="h-8 w-56"
				/>
			) : null}
		</div>
	);
}
