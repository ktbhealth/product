import { createFileRoute, Link, useLoaderData } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@ktb/auth-better/client";
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
import type { PageI18nSlice } from "@ktb/kernel";

import { appCatalogT, i18nSliceFromHeadMatches } from "#/lib/i18n.ts";

/** Where the emailed link lands — back here, now showing the verified state. */
const CALLBACK_URL = "/verify-email";

export const Route = createFileRoute("/verify-email")({
	head: (ctx) => {
		// The ROOT match's i18n slice — it already honors `?locale=`;
		// no per-route i18nRouteFn call needed (that would be a second,
		// search-blind server roundtrip per navigation).
		const i18n = i18nSliceFromHeadMatches(ctx?.matches);
		const title = appCatalogT(i18n)("app.verify_meta_title");
		return { meta: [{ title }] };
	},
	component: VerifyEmailPage,
});

// Resend screen for the sign-up verification link. Signed-in users
// resend to their own address; anonymous visitors type one. The
// confirmation is the same whether or not the address has an account,
// so the page never reveals which emails are registered.
function VerifyEmailPage() {
	const { data: session, isPending: sessionPending } = authClient.useSession();
	// The root session knows which side the account is on: a patient
	// account continues to its portal, everyone else to the app home.
	const { user: account, i18n } = useLoaderData({ from: "__root__" });
	const slice = i18n as PageI18nSlice | undefined;
	const appT = appCatalogT(slice);
	const t = (key: string, params: Record<string, unknown> = {}) => {
		const full = `app.${key}`;
		const resolved = appT(full, params);
		return resolved === full ? key : resolved;
	};
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
			setError(res.error.message ?? t("verify_error_fallback"));
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
						<CardTitle>{t("verify_done_heading")}</CardTitle>
						<CardDescription>{t("verify_done_desc", { email: user.email })}</CardDescription>
					</CardHeader>
					<CardContent>
						<Link
							to={account?.patientOnly ? "/portal" : "/"}
							className={buttonVariants({ className: "w-full" })}
						>
							{t("verify_continue")}
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
					<CardTitle>{t("verify_heading")}</CardTitle>
					<CardDescription>
						{user ? t("verify_desc_signed", { email: user.email }) : t("verify_desc_anon")}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="flex flex-col gap-4">
						{user ? null : (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="email">{t("login_email")}</Label>
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
								<AlertDescription>{t("verify_sent")}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? <Spinner /> : null}
							{pending ? t("login_pending") : t("verify_submit")}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}
