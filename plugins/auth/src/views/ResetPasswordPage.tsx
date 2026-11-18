import { Link } from "@tanstack/react-router";
import { useState, type FormEvent, type ReactNode } from "react";
import { authClient } from "@ktb/auth-better/client";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Alert, AlertDescription } from "@ktbhealth/ui/components/alert";
import { Button, buttonVariants } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";
import { Input } from "@ktbhealth/ui/components/input";
import { Label } from "@ktbhealth/ui/components/label";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { authMessages, I18N_NAMESPACE } from "../i18n.ts";

/** Centered card shell shared by the page's three states. */
const Shell = ({ children }: { children: ReactNode }) => (
	<div className="flex min-h-[60vh] items-center justify-center">
		<Card className="w-full max-w-sm">{children}</Card>
	</div>
);

/**
 * /reset-password — where the emailed link lands after the auth API
 * validates the token (`?token=` on success, `?error=` on failure).
 * A valid token shows the new-password form; anything else shows the
 * invalid-link card pointing back at /forgot-password. No captcha on
 * the form — the single-use token IS the credential.
 */
export function ResetPasswordPage({
	i18n,

	locale,
	token,
	invalid,
}: {
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale: string;
	/** Reset token from the search params, when the link validated. */
	readonly token: string | undefined;
	/** The API rejected the link (`?error=`) or it carried no token. */
	readonly invalid: boolean;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, authMessages(locale));
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState(false);
	const [pending, setPending] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!password || token === undefined || pending) return;
		if (confirmPassword !== password) {
			setError(t.errorPasswordMismatch);
			return;
		}
		setPending(true);
		setError(null);
		const res = await authClient.resetPassword({
			newPassword: password,
			token,
		} as Parameters<typeof authClient.resetPassword>[0]);
		setPending(false);
		if (res.error) {
			setError(res.error.message ?? t.resetError);
			return;
		}
		setDone(true);
	};

	if (invalid) {
		return (
			<Shell>
				<CardHeader>
					<CardTitle>{t.resetInvalidHeading}</CardTitle>
					<CardDescription>{t.resetInvalidDesc}</CardDescription>
				</CardHeader>
				<CardContent>
					<Link to="/forgot-password" className={buttonVariants({ className: "w-full" })}>
						{t.resetRequestNew}
					</Link>
					<Link
						to="/login"
						className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
					>
						{t.backToSignIn}
					</Link>
				</CardContent>
			</Shell>
		);
	}

	if (done) {
		return (
			<Shell>
				<CardHeader>
					<CardTitle>{t.resetDoneHeading}</CardTitle>
					<CardDescription>{t.resetDoneDesc}</CardDescription>
				</CardHeader>
				<CardContent>
					<Link to="/login" className={buttonVariants({ className: "w-full" })}>
						{t.backToSignIn}
					</Link>
				</CardContent>
			</Shell>
		);
	}

	return (
		<Shell>
			<CardHeader>
				<CardTitle>{t.resetHeading}</CardTitle>
				<CardDescription>{t.resetDesc}</CardDescription>
			</CardHeader>
			<CardContent>
				<form onSubmit={submit} className="flex flex-col gap-4">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="new-password">{t.newPassword}</Label>
						<Input
							id="new-password"
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="confirm-password">{t.confirmPassword}</Label>
						<Input
							id="confirm-password"
							type="password"
							autoComplete="new-password"
							required
							minLength={8}
							value={confirmPassword}
							onChange={(e) => setConfirmPassword(e.target.value)}
						/>
					</div>
					{error ? (
						<Alert variant="destructive">
							<AlertDescription>{error}</AlertDescription>
						</Alert>
					) : null}
					<Button type="submit" disabled={pending} className="w-full">
						{pending ? <Spinner /> : null}
						{pending ? t.pending : t.resetSubmit}
					</Button>
				</form>
				<Link
					to="/login"
					className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
				>
					{t.backToSignIn}
				</Link>
			</CardContent>
		</Shell>
	);
}
