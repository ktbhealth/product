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
import { Turnstile } from "@ktbhealth/ui/components/turnstile";

import { inviteMessages, type InviteFailure, I18N_NAMESPACE } from "../i18n.ts";
import { INVITE_DESTINATIONS } from "../kinds.ts";
import type { InviteKind } from "../schema.ts";

/** What the page knows about a live link. */
export interface AcceptInviteInvite {
	readonly email: string;
	readonly kind: InviteKind;
	readonly inviterName: string;
	readonly accountExists: boolean;
}

/** Server call the page needs — bound to this plugin's fn (and the
 * link's token) by the route. */
export interface AcceptInviteApi {
	accept(input: {
		readonly name: string;
		readonly password: string;
	}): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: InviteFailure }>;
}

/**
 * Where an invite email's accept link lands. The link proves the
 * person controls the invited address, so a new account only needs a
 * name and a password — no separate verification step — and the page
 * signs them in right after creating it. An address that already has
 * an account creates nothing here: it is sent to sign in. The
 * better-auth client is inherently impl-bound (documented vite.config
 * exception, like the sign-in views).
 */
export function AcceptInvitePage({
	invite,
	i18n,

	locale,
	api,
}: {
	/** Null when the link is unknown, already used or expired. */
	readonly invite: AcceptInviteInvite | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale: string;
	readonly api: AcceptInviteApi;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, inviteMessages(locale));
	const [name, setName] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [created, setCreated] = useState(false);
	const [pending, setPending] = useState(false);

	if (invite === null) {
		return (
			<Notice title={t.invalidTitle} body={t.invalidBody}>
				<a href="/login/doctor" className={buttonVariants({ className: "w-full" })}>
					{t.signIn}
				</a>
			</Notice>
		);
	}
	const destination = INVITE_DESTINATIONS[invite.kind];
	if (invite.accountExists || created) {
		return (
			<Notice
				title={created ? t.createdTitle : t.existsTitle}
				body={created ? t.createdSignIn : t.existsBody(invite.email)}
			>
				<a href={destination.login} className={buttonVariants({ className: "w-full" })}>
					{t.signIn}
				</a>
			</Notice>
		);
	}

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (pending) return;
		if (confirmPassword !== password) {
			setError(t.errorPasswordMismatch);
			return;
		}
		setPending(true);
		setError(null);
		const accepted = await api
			.accept({ name, password })
			.catch(() => ({ ok: false as const, error: "failed" as const }));
		if (!accepted.ok) {
			setPending(false);
			setError(t.errors[accepted.error]);
			return;
		}
		// The account exists now. Sign in with the password just chosen;
		// if that fails the person is not locked out — they sign in from
		// the regular screen.
		const signedIn = await authClient.signIn
			.email({
				email: invite.email,
				password,
				captchaToken: captchaToken ?? undefined,
			} as Parameters<typeof authClient.signIn.email>[0])
			.catch(() => ({ error: {} }));
		if (signedIn.error) {
			setPending(false);
			setCreated(true);
			return;
		}
		// Signed in: stay pending until the browser navigates away.
		window.location.assign(destination.home);
	};

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t.heading[invite.kind](invite.inviterName)}</CardTitle>
					<CardDescription>{t.description}</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="email">{t.email}</Label>
							<Input
								id="email"
								type="email"
								autoComplete="username"
								readOnly
								value={invite.email}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="name">{t.name}</Label>
							<Input
								id="name"
								autoComplete="name"
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="password">{t.password}</Label>
							<Input
								id="password"
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
						<Turnstile onToken={setCaptchaToken} />
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? <Spinner /> : null}
							{pending ? t.pending : t.submit}
						</Button>
					</form>
				</CardContent>
			</Card>
		</div>
	);
}

/** A dead end with one way out — used when there is nothing to create. */
function Notice({
	title,
	body,
	children,
}: {
	readonly title: string;
	readonly body: string;
	readonly children: ReactNode;
}) {
	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{title}</CardTitle>
					<CardDescription>{body}</CardDescription>
				</CardHeader>
				<CardContent>{children}</CardContent>
			</Card>
		</div>
	);
}
