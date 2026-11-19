import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@ktb/auth-better/client";
import { sliceMessages } from "@ktb/i18n";
import type { PageContext } from "@ktb/kernel";

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
import { Turnstile } from "@ktbhealth/ui/components/turnstile";

import { I18N_NAMESPACE, verifyEmailMessages } from "../i18n.ts";

/** Where the emailed link lands — back here, now showing the verified state. */
const CALLBACK_URL = "/verify-email";

export interface VerifyEmailPageProps {
	/** Loader payload: `{ emailEnabled }` from the page descriptor's
	 * server-side Effect (null when invoked without one, e.g. tests). */
	readonly data: unknown;
	readonly ctx: PageContext;
}

/**
 * /verify-email — resend screen for the sign-up verification link,
 * migrated from the retired host file route into a `pages` descriptor
 * (plugin id `verify-email.pages`). Signed-in users resend to their
 * own address; anonymous visitors type one. The confirmation is the
 * same whether or not the address has an account, so the page never
 * reveals which emails are registered.
 *
 * Session facts come from `authClient.useSession()` (email +
 * emailVerified); the account's `patientOnly` flag — which picks the
 * post-verification destination — arrives via `ctx.user` (the host
 * injects the session account into PageContext). Copy resolves through
 * `sliceMessages(ctx.i18n, "verify-email", …)`; `data.emailEnabled ===
 * false` swaps the form for an unavailable notice on deployments with
 * no outbound email (same contract as the auth plugin's
 * forgot-password page).
 */
export function VerifyEmailPage({ data, ctx }: VerifyEmailPageProps) {
	const { data: session, isPending: sessionPending } = authClient.useSession();
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, verifyEmailMessages(ctx.locale));
	const emailEnabled =
		(data as { emailEnabled?: unknown } | null | undefined)?.emailEnabled !== false;
	const [typedEmail, setTypedEmail] = useState("");
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [pending, setPending] = useState(false);

	const user = session?.user;
	const email = user?.email ?? typedEmail.trim();

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!email || pending) return;
		setPending(true);
		setError(null);
		setSent(false);
		const res = await authClient.sendVerificationEmail({
			email,
			callbackURL: CALLBACK_URL,
			captchaToken: captchaToken ?? undefined,
		} as Parameters<typeof authClient.sendVerificationEmail>[0]);
		setPending(false);
		if (res.error) {
			setError(res.error.message ?? t.errorFallback);
			return;
		}
		setSent(true);
	};

	if (sessionPending) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<Spinner />
			</div>
		);
	}

	if (user?.emailVerified) {
		return (
			<div className="flex min-h-[60vh] items-center justify-center">
				<Card className="w-full max-w-sm">
					<CardHeader>
						<CardTitle>{t.doneHeading}</CardTitle>
						<CardDescription>{t.doneDesc(user.email)}</CardDescription>
					</CardHeader>
					<CardContent>
						<Link
							to={ctx.user?.patientOnly ? "/portal" : "/"}
							className={buttonVariants({ className: "w-full" })}
						>
							{t.continueLabel}
						</Link>
					</CardContent>
				</Card>
			</div>
		);
	}

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t.heading}</CardTitle>
					<CardDescription>
						{emailEnabled ? (user ? t.descSigned(user.email) : t.descAnon) : t.unavailable}
					</CardDescription>
				</CardHeader>
				<CardContent>
					{emailEnabled ? (
						<form onSubmit={submit} className="flex flex-col gap-4">
							{user ? null : (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="email">{t.emailLabel}</Label>
									<Input
										id="email"
										type="email"
										autoComplete="email"
										required
										value={typedEmail}
										onChange={(e) => setTypedEmail(e.target.value)}
									/>
								</div>
							)}
							<Turnstile onToken={setCaptchaToken} />
							{error ? (
								<Alert variant="destructive">
									<AlertDescription>{error}</AlertDescription>
								</Alert>
							) : null}
							{sent ? (
								<Alert>
									<AlertDescription>{t.sent}</AlertDescription>
								</Alert>
							) : null}
							<Button type="submit" disabled={pending} className="w-full">
								{pending ? <Spinner /> : null}
								{pending ? t.pending : t.submit}
							</Button>
						</form>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}
