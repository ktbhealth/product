import { Link } from "@tanstack/react-router";
import { EyeIcon, EyeOffIcon } from "lucide-react";
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
import { platformAdminAccessFn } from "../fns.ts";

/**
 * /login/admin — dedicated superadmin sign-in. Unlike LoginPage there is
 * no sign-up tab: this surface only authenticates existing accounts,
 * then checks the platform-admin gate (email allowlist or RBAC grant)
 * before sending the user to /platform. A denied account keeps its
 * session (it is a valid login, just not an admin one) and sees an
 * explicit error — every admin path re-checks the gate server-side.
 */
export function AdminLoginPage({
	i18n,
	locale,
}: {
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, authMessages(locale));
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!email.trim() || !password || pending) return;
		setPending(true);
		setError(null);
		const res = await authClient.signIn.email({
			email,
			password,
			captchaToken: captchaToken ?? undefined,
		} as Parameters<typeof authClient.signIn.email>[0]);
		if (res.error) {
			setPending(false);
			setError(res.error.message ?? t.errorFallback);
			return;
		}
		// Signed in: the admin gate decides the destination. Stays
		// pending until the browser navigates (or the denial renders).
		const allowed = await platformAdminAccessFn();
		if (allowed) {
			window.location.assign("/platform");
			return;
		}
		setPending(false);
		setError(t.errorDenied);
	};

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{t.headingAdmin}</CardTitle>
					<CardDescription>{t.descAdmin}</CardDescription>
				</CardHeader>
				<CardContent>
					<form onSubmit={submit} className="flex flex-col gap-4">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="admin-email">{t.email}</Label>
							<Input
								id="admin-email"
								type="email"
								autoComplete="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="admin-password">{t.password}</Label>
							<div className="relative">
								<Input
									id="admin-password"
									type={showPassword ? "text" : "password"}
									autoComplete="current-password"
									required
									minLength={8}
									value={password}
									onChange={(e) => setPassword(e.target.value)}
									className="pr-10"
								/>
								<Button
									type="button"
									variant="ghost"
									size="icon"
									className="absolute inset-y-0 right-1 my-auto text-muted-foreground"
									aria-label={showPassword ? t.hidePassword : t.showPassword}
									onClick={() => setShowPassword((v) => !v)}
								>
									{showPassword ? <EyeOffIcon /> : <EyeIcon />}
								</Button>
							</div>
						</div>
						<Turnstile onToken={setCaptchaToken} />
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? <Spinner /> : null}
							{pending ? t.pending : t.submitAdmin}
						</Button>
					</form>
					<Link
						to="/login/doctor"
						className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
					>
						{t.signInLink}
					</Link>
				</CardContent>
			</Card>
		</div>
	);
}
