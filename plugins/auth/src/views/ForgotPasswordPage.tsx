import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@ktb/auth-better/client";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import { Alert, AlertDescription } from "@ktbhealth/ui/components/alert";
import { Button } from "@ktbhealth/ui/components/button";
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
import { Turnstile } from "@ktbhealth/ui/components/turnstile";

import { authMessages, I18N_NAMESPACE } from "../i18n.ts";

/**
 * /forgot-password — the "Forgot your password?" destination every
 * sign-in screen links to. Sends a single-use reset link through
 * better-auth's /request-password-reset; the confirmation is the same
 * whether or not the address has an account, so the page never
 * reveals registrations. `emailEnabled` swaps the form for an
 * unavailable notice on deployments with no outbound email.
 */
export function ForgotPasswordPage({
	i18n,

	locale,
	emailEnabled,
}: {
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale: string;
	readonly emailEnabled: boolean;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, authMessages(locale));
	const [email, setEmail] = useState("");
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [pending, setPending] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!email.trim() || pending) return;
		setPending(true);
		setError(null);
		setSent(false);
		const res = await authClient.requestPasswordReset({
			email: email.trim(),
			// The emailed link bounces through /api/auth/reset-password/:token,
			// which validates it and forwards to this page with `?token=`
			// or `?error=INVALID_TOKEN`.
			redirectTo: "/reset-password",
			captchaToken: captchaToken ?? undefined,
		} as Parameters<typeof authClient.requestPasswordReset>[0]);
		setPending(false);
		if (res.error) {
			setError(res.error.message ?? t.errorFallback);
			return;
		}
		setSent(true);
	};

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t.forgotHeading}</CardTitle>
					<CardDescription>{emailEnabled ? t.forgotDesc : t.forgotUnavailable}</CardDescription>
				</CardHeader>
				<CardContent>
					{emailEnabled ? (
						<form onSubmit={submit} className="flex flex-col gap-4">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="email">{t.email}</Label>
								<Input
									id="email"
									type="email"
									autoComplete="email"
									required
									value={email}
									onChange={(e) => setEmail(e.target.value)}
								/>
							</div>
							<Turnstile onToken={setCaptchaToken} />
							{error ? (
								<Alert variant="destructive">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							) : null}
							{sent ? (
								<Alert>
									<AlertDescription>{t.forgotSent}</AlertDescription>
								</Alert>
							) : null}
							<Button type="submit" disabled={pending} className="w-full">
								{pending ? <Spinner /> : null}
								{pending ? t.pending : t.forgotSubmit}
							</Button>
						</form>
					) : null}
					<Link
						to="/login"
						className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
					>
						{t.backToSignIn}
					</Link>
				</CardContent>
			</Card>
		</div>
	);
}
