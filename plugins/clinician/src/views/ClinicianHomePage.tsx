import { Link } from "@tanstack/react-router";
import { ClipboardListIcon, UsersIcon } from "lucide-react";

import type { PageContext } from "@ktb/kernel";

import { usePortalInstanceId } from "./portal-base.ts";

/** Clinical portal landing (P-081): the instance index — a directory of
 * the portal's sections. Section pages are the domain plugins' views
 * mounted as portal pages; in-page links that target app routes
 * (/patients/$id, /consultations/new, …) still navigate to the app
 * shell until those surfaces get portal twins. The shared workspace
 * mounts under /portal/doctor and /portal/secretary — links resolve the
 * current instance from the live pathname. */
export function ClinicianHomePage({ ctx }: { data: unknown; ctx: PageContext }) {
	void ctx;
	const instance = usePortalInstanceId();
	return (
		<div className="mx-auto max-w-3xl p-6">
			<h1 className="text-2xl font-bold tracking-tight">Clinician workspace</h1>
			<p className="mt-1 text-sm text-muted-foreground">
				Patients and consultations for the doctor you act as.
			</p>
			<div className="mt-6 grid gap-4 sm:grid-cols-2">
				<Link
					to="/portal/$instance/$"
					params={{ instance, _splat: "patients" }}
					className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-foreground/20 hover:shadow"
				>
					<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
						<UsersIcon className="size-5" />
					</span>
					<span>
						<span className="block font-semibold">Patients</span>
						<span className="block text-sm text-muted-foreground">
							Records, demographics and deletion.
						</span>
					</span>
				</Link>
				<Link
					to="/portal/$instance/$"
					params={{ instance, _splat: "consultations" }}
					className="flex items-center gap-3 rounded-2xl border border-border bg-card p-4 shadow-sm transition hover:border-foreground/20 hover:shadow"
				>
					<span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
						<ClipboardListIcon className="size-5" />
					</span>
					<span>
						<span className="block font-semibold">Consultations</span>
						<span className="block text-sm text-muted-foreground">
							Visit notes, transcripts and anamnesis.
						</span>
					</span>
				</Link>
			</div>
		</div>
	);
}
