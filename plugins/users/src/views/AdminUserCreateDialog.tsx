import { useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { Button } from "@ktbhealth/ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ktbhealth/ui/components/dialog";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";

import { createUserFn } from "../fns.ts";
import type { UserMessages } from "../i18n.ts";

type FormState = {
	name: string;
	email: string;
	password: string;
};

const EMPTY: FormState = { name: "", email: "", password: "" };

/**
 * Platform-admin account create: name + email + password go to the
 * Accounts port, which marks the email verified (the admin vouches for
 * the address) and stores the credential hash. Port rejections render
 * as inline errors; a denied gate shows the generic failure.
 */
export function AdminUserCreateDialog({ t, onClose }: { t: UserMessages; onClose: () => void }) {
	const router = useRouter();
	const [form, setForm] = useState<FormState>(EMPTY);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const set =
		<K extends keyof FormState>(key: K) =>
		(e: { target: { value: string } }) =>
			setForm((f) => ({ ...f, [key]: e.target.value }));

	const submit = async () => {
		/* v8 ignore next -- the submit button is disabled while busy */
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await createUserFn({
				data: { name: form.name, email: form.email, password: form.password },
			});
			if (!res.ok) {
				setError(
					res.error === "exists"
						? t.createExists
						: res.error === "invalid_password"
							? t.createInvalidPassword
							: t.createFailed,
				);
				return;
			}
			onClose();
			await router.invalidate();
		} finally {
			setBusy(false);
		}
	};

	return (
		<Dialog
			open
			onOpenChange={(open) => {
				/* v8 ignore next -- mounted only while creating; only close events fire */
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.createTitle}</DialogTitle>
				</DialogHeader>
				<p className="text-sm text-muted-foreground">{t.createDescription}</p>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<Field>
						<FieldLabel htmlFor="admin-user-name">{t.fieldName}</FieldLabel>
						<Input
							id="admin-user-name"
							value={form.name}
							onChange={set("name")}
							autoComplete="off"
							required
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="admin-user-email">{t.fieldEmail}</FieldLabel>
						<Input
							id="admin-user-email"
							type="email"
							value={form.email}
							onChange={set("email")}
							autoComplete="off"
							required
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="admin-user-password">{t.fieldPassword}</FieldLabel>
						<Input
							id="admin-user-password"
							type="password"
							value={form.password}
							onChange={set("password")}
							autoComplete="new-password"
							required
						/>
					</Field>
					{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
							{t.cancel}
						</Button>
						<Button type="submit" disabled={busy}>
							{t.createUser}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
