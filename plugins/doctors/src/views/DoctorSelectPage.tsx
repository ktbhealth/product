import { useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { Alert, AlertDescription } from "@ktbhealth/ui/components/alert";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ktbhealth/ui/components/card";

import { doctorMessages, I18N_NAMESPACE } from "../i18n.ts";

export interface DoctorProfileItem {
	readonly doctorId: number;
	readonly displayName: string;
	readonly role: "owner" | "secretary";
}

/** Server actions the chooser needs — bound to this plugin's fns by the route. */
export interface DoctorSelectApi {
	select(doctorId: number): Promise<{ ok: boolean }>;
}

export function DoctorSelectPage({
	profiles,
	activeDoctorId,
	i18n,
	locale,
	api,
	onDone,
}: {
	/** Never empty — the route sends accounts with no doctor profile to
	 * the patient portal. */
	profiles: readonly DoctorProfileItem[];
	/** The profile currently in effect, if any. */
	activeDoctorId: number | null;
	/** Active UI locale, injected by the host. */
	locale: string;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	api: DoctorSelectApi;
	/** Called once a profile is in effect — the host leaves the chooser
	 * for the clinical surface the picked profile belongs to. */
	onDone: (profile: DoctorProfileItem) => void;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, doctorMessages(locale));
	const [pending, setPending] = useState(false);
	const [failed, setFailed] = useState(false);

	const run = async (profile: DoctorProfileItem) => {
		setPending(true);
		setFailed(false);
		const ok = await api.select(profile.doctorId).then(
			(res) => res.ok,
			() => false,
		);
		if (ok) return onDone(profile);
		setPending(false);
		setFailed(true);
	};

	return (
		<div className="mx-auto flex max-w-xl flex-col gap-4">
			<div>
				<h1 className="text-2xl font-bold tracking-tight">{t.selectTitle}</h1>
				<p className="mt-1 text-sm text-muted-foreground">{t.selectDescription}</p>
			</div>
			{failed ? (
				<Alert variant="destructive">
					<AlertDescription>{t.error}</AlertDescription>
				</Alert>
			) : null}
			{profiles.map((profile) => (
				<Card key={profile.doctorId}>
					<CardHeader>
						<CardTitle className="flex items-center gap-2">
							{profile.displayName}
							{profile.doctorId === activeDoctorId ? <Badge>{t.current}</Badge> : null}
						</CardTitle>
						<CardDescription>
							{profile.role === "owner" ? t.roleOwner : t.roleSecretary}
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Button
							variant={profile.doctorId === activeDoctorId ? "outline" : "default"}
							disabled={pending}
							onClick={() => void run(profile)}
						>
							{t.choose}
						</Button>
					</CardContent>
				</Card>
			))}
		</div>
	);
}
