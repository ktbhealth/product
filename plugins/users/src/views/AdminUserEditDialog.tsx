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

import { updateUserFn } from "../fns.ts";
import type { UserMessages } from "../i18n.ts";

/**
 * Platform-admin profile edit: name + sign-in email go to the Auth
 * port through the Users service. "exists" renders as an inline
 * error; a denied gate shows the generic save error.
 */
export function AdminUserEditDialog({
	t,
	user,
	onClose,
}: {
	t: UserMessages;
	user: { readonly id: string; readonly name: string; readonly email: string };
	onClose: () => void;
}) {
	const router = useRouter();
	const [name, setName] = useState(user.name);
	const [email, setEmail] = useState(user.email);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		/* v8 ignore next -- the submit button is disabled while busy */
		if (busy) return;
		setBusy(true);
		setError(null);
		try {
			const res = await updateUserFn({ data: { userId: user.id, name, email } });
			if (!res.ok) {
				setError(res.error === "exists" ? t.editExists : t.saveError);
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
				/* v8 ignore next -- mounted only while editing; only close events fire */
				if (!open) onClose();
			}}
		>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t.editTitle}</DialogTitle>
				</DialogHeader>
				<p className="text-sm text-muted-foreground">{t.editDescription}</p>
				<form
					className="space-y-3"
					onSubmit={(e) => {
						e.preventDefault();
						void submit();
					}}
				>
					<Field>
						<FieldLabel htmlFor="admin-user-edit-name">{t.fieldName}</FieldLabel>
						<Input
							id="admin-user-edit-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							autoComplete="off"
							required
						/>
					</Field>
					<Field>
						<FieldLabel htmlFor="admin-user-edit-email">{t.fieldEmail}</FieldLabel>
						<Input
							id="admin-user-edit-email"
							type="email"
							value={email}
							onChange={(e) => setEmail(e.target.value)}
							autoComplete="off"
							required
						/>
					</Field>
					{error !== null ? <p className="text-sm text-destructive">{error}</p> : null}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={onClose} disabled={busy}>
							{t.cancel}
						</Button>
						<Button type="submit" disabled={busy}>
							{t.saveChanges}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
