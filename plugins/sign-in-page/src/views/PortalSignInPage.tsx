import { Link } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";
import { authClient } from "@ktb/auth-better/client";
import { ForgotPasswordLink } from "@ktb/auth-plugin/views";
import { doctorContextFn } from "@ktb/doctors/fns";
import { sliceMessages } from "@ktb/i18n";
import type { PageContext } from "@ktb/kernel";
import { PORTAL_AUDIENCE } from "@ktb/portal/rules";
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

import { portalAudiencesFn } from "../fns.ts";
import { I18N_NAMESPACE, signInMessages } from "../i18n.ts";
import { loginTileTargets, type LoginTileStates } from "../login-tiles.ts";

export interface PortalSignInPageProps {
	/** Page loader payload: `{ emailEnabled }` from the descriptor's
	 * server-side Effect (null when invoked without one, e.g. tests). */
	readonly data: unknown;
	readonly ctx: PageContext;
}

/**
 * /login/patient — patient sign-in (moved from the host file route
 * apps/web/src/routes/login-patient.tsx). Same accounts as the doctor
 * page — what differs is where it leads (the portal) and what a
 * sign-up creates: a patient account has no doctor profile.
 *
 * Post-sign-in funnel (unchanged from the host route): a staff
 * account — a doctor/secretary profile and no patient side — does not
 * satisfy the patient audience, so /portal would 404 it at the gate;
 * it routes through the same funnel as /login/doctor instead
 * (/portal/<instance> by profile role, "/" when nothing resolves). The
 * doctor cross-link follows the /login picker's rule (P-058/P-099):
 * no offer when the doctor sign-in tile is not live.
 */
export function PortalSignInPage({ data, ctx }: PortalSignInPageProps) {
	const emailEnabled =
		(data as { emailEnabled?: unknown } | null | undefined)?.emailEnabled !== false;
	// ctx.pluginStates is the raw enablement snapshot the chrome gates
	// check `requires` against; when a host omits it, ctx.plugins is
	// already enabled-filtered, so every registry id counts as live.
	const states: LoginTileStates = ctx.pluginStates ?? {
		enabled: ctx.plugins.map((p) => p.id),
	};
	const doctorLogin = loginTileTargets(ctx.plugins, states).has("/login/doctor");
	const t = sliceMessages(ctx.i18n, I18N_NAMESPACE, signInMessages(ctx.locale));
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
			setError(t.errorPasswordMismatch);
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
			setError(res.error.message ?? t.errorFallback);
			return;
		}
		// Signed in: stay pending until the browser navigates away.
		if (mode === "up") {
			window.location.assign(emailEnabled ? "/verify-email" : "/portal");
			return;
		}
		// A staff account (a doctor/secretary profile and no patient
		// side) does not satisfy the patient audience — /portal would
		// 404 it at the gate. Route it through the same post-login
		// funnel as /login/doctor instead.
		try {
			const audiences = await portalAudiencesFn();
			if (!audiences.includes(PORTAL_AUDIENCE.patient)) {
				const context = await doctorContextFn();
				const profiles = context?.profiles ?? [];
				window.location.assign(
					profiles.length === 0
						? "/"
						: profiles.some((p) => p.role === "owner")
							? "/portal/doctor"
							: "/portal/secretary",
				);
				return;
			}
		} catch {
			// Lookup failure: fall through to the patient portal.
		}
		window.location.assign("/portal");
	};

	return (
		<div className="flex min-h-[60vh] items-center justify-center">
			<Card className="w-full max-w-sm">
				<CardHeader>
					<CardTitle>{mode === "in" ? t.patientHeadingIn : t.patientHeadingUp}</CardTitle>
					<CardDescription>{mode === "in" ? t.patientDescIn : t.patientDescUp}</CardDescription>
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
							<TabsTrigger value="in">{t.tabIn}</TabsTrigger>
							<TabsTrigger value="up">{t.tabUp}</TabsTrigger>
						</TabsList>
					</Tabs>
					<form onSubmit={submit} className="flex flex-col gap-4">
						{mode === "up" ? (
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
						) : null}
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
						<div className="flex flex-col gap-1.5">
							<div className="flex items-center justify-between">
								<Label htmlFor="password">{t.password}</Label>
								{mode === "in" ? <ForgotPasswordLink>{t.forgotPassword}</ForgotPasswordLink> : null}
							</div>
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
						) : null}
						<Turnstile onToken={setCaptchaToken} />
						{error ? (
							<Alert variant="destructive">
								<AlertDescription>{error}</AlertDescription>
							</Alert>
						) : null}
						<Button type="submit" disabled={pending} className="w-full">
							{pending ? <Spinner /> : null}
							{pending ? t.pending : mode === "in" ? t.submitIn : t.submitUp}
						</Button>
					</form>
					{doctorLogin ? (
						<Link
							to="/login/doctor"
							className="mt-4 block text-center text-sm text-muted-foreground transition hover:text-foreground"
						>
							{t.doctorLink}
						</Link>
					) : null}
				</CardContent>
			</Card>
		</div>
	);
}
