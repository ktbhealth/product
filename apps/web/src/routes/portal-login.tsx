import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@ktb/auth-better/client";
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
import { Tabs, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";
import { Turnstile } from "@ktbhealth/ui/components/turnstile";
import { emailEnabledFn } from "#/lib/fns.ts";

import { appCatalogT, i18nSliceFromHeadMatches, useRootI18nSlice } from "#/lib/i18n.ts";

export const Route = createFileRoute("/portal/login")({
	head: (ctx) => {
		// The ROOT match's i18n slice — it already honors `?locale=`;
		// no per-route i18nRouteFn call needed (that would be a second,
		// search-blind server roundtrip per navigation).
		const i18n = i18nSliceFromHeadMatches(ctx?.matches);
		const title = appCatalogT(i18n)("app.portal_login_meta_title");
		return { meta: [{ title }] };
	},
	loader: async () => ({
		emailEnabled: await emailEnabledFn(),
	}),
	component: PortalSignInPage,
});

// Patient sign-in. Same accounts as the doctor page — what differs is
// where it leads (the portal) and what a sign-up creates: a patient
// account has no doctor profile.
function PortalSignInPage() {
	const { emailEnabled } = Route.useLoaderData();
	const slice = useRootI18nSlice();
	const appT = appCatalogT(slice);
	const t = (key: string, params: Record<string, unknown> = {}) => {
		const full = `app.${key}`;
		const resolved = appT(full, params);
		return resolved === full ? key : resolved;
	};
	const [mode, setMode] = useState<"in" | "up">("in");
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [captchaToken, setCaptchaToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);

	const submit = async (e: FormEvent) => {
		e.preventDefault();
		if (!email.trim() || !password || pending) return;
		if (mode === "up" && confirmPassword !== password) {
			setError(t("login_error_password_mismatch"));
			return;
		}
		setPending(true);
		setError(null);
		const credentials = { email, password, captchaToken: captchaToken ?? undefined };
		const res =
			mode === "up"
				? await authClient.signUp.email({
						...credentials,
						name: name.trim(),
						// Where the emailed verification link lands.
						callbackURL: "/verify-email",
					} as Parameters<typeof authClient.signUp.email>[0])
				: await authClient.signIn.email(
						credentials as Parameters<typeof authClient.signIn.email>[0],
					);
		if (res.error) {
			setPending(false);
			setError(res.error.message ?? t("login_error_fallback"));
			return;
		}
		// Signed in: stay pending until the browser navigates away.
		if (mode === "up") {
			window.location.assign(emailEnabled ? "/verify-email" : "/portal");
			return;
		}
		window.location.assign("/portal");
	};

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>
						{mode === "in" ? t("portal_login_heading_in") : t("portal_login_heading_up")}
					</CardTitle>
					<CardDescription>
						{mode === "in" ? t("portal_login_desc_in") : t("portal_login_desc_up")}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<Tabs
						value={mode}
						onValueChange={(value) => {
							setMode(value as "in" | "up");
							setConfirmPassword("");
							setError(null);
						}}
						className="mb-4"
					>
						<TabsList className="w-full">
							<TabsTrigger value="in">{t("login_tab_in")}</TabsTrigger>
							<TabsTrigger value="up">{t("login_tab_up")}</TabsTrigger>
						</TabsList>
					</Tabs>
					<form onSubmit={submit} className="flex flex-col gap-4">
						{mode === "up" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="name">{t("portal_login_name")}</Label>
								<Input
									id="name"
									autoComplete="name"
									required
									value={name}
									onChange={(e) => setName(e.target.value)}
								/>
							</div>
						) : null}
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="email">{t("login_email")}</Label>
							<Input
								id="email"
								type="email"
								autoComplete="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="password">{t("login_password")}</Label>
							<Input
								id="password"
								type="password"
								autoComplete={mode === "in" ? "current-password" : "new-password"}
								required
								minLength={8}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
							/>
						</div>
						{mode === "up" ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="confirm-password">{t("login_confirm_password")}</Label>
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
						) : null}
						<Turnstile onToken={setCaptchaToken} />
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? <Spinner /> : null}
							{pending
								? t("login_pending")
								: mode === "in"
									? t("login_submit_in")
									: t("login_submit_up")}
						</Button>
					</form>
					<Link
						to="/login"
						className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
					>
						{t("portal_login_doctor_link")}
					</Link>
				</CardContent>
			</Card>
		</div>
	);
}
