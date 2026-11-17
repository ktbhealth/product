import { Link } from "@tanstack/react-router";
import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { buttonVariants } from "@ktbhealth/ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ktbhealth/ui/components/dropdown-menu";

import type { ChromeProps } from "@ktb/kernel";

const NAV_LINK =
	"rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground transition hover:bg-muted hover:text-foreground";

/**
 * Session chrome contributed to `app.header.session` (P-060, merged
 * into the auth plugin by P-062): doctor + patient login entries when
 * anonymous (patient is the primary CTA), otherwise the account menu
 * (avatar + name/email + portal links + sign out). A patient account
 * (`user.patientOnly`) gets no doctor-side links — only its own
 * consultations. The profile actions (switch doctor, secretaries)
 * live in the clinical portal sidebars, not here. Labels come from
 * the host-injected `labels` record and the sign-out flow from
 * `signOut` — plugins cannot import the host's i18n runtime or auth
 * adapters.
 */
export function SessionMenu({ user, labels, signOut }: ChromeProps) {
	if (!user) {
		return (
			<>
				<Link to="/login/doctor" className={NAV_LINK}>
					{labels.doctorLogin ?? "I am a doctor"}
				</Link>
				{/* `/login/patient` is a host route outside this plugin's
				    FileRoutesByPath — a plain anchor keeps the full
				    navigation (the invite pages do the same). */}
				<a href="/login/patient" className={buttonVariants({ size: "sm" })}>
					{labels.patientLogin ?? "I am a patient"}
				</a>
			</>
		);
	}
	const patientOnly = user.patientOnly === true;
	// Secretary-only accounts get the secretary portal label/link; an
	// unresolved role (older hosts) defaults to the doctor surface.
	const secretary = user.clinicalRole === "secretary";
	// The patient portal only makes sense when the account actually holds
	// a patient record — a doctor without one gets no link to an empty
	// portal. Unresolved counts (older hosts) hide it, fail-closed.
	const hasPatientSide = (user.patientProfiles ?? 0) > 0;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground">
				<Avatar size="sm">
					<AvatarFallback className="bg-muted text-[11px] font-semibold uppercase">
						{user.name?.[0] ?? "?"}
					</AvatarFallback>
				</Avatar>
				<span className="max-w-32 truncate">{user.name}</span>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-52">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
						<span className="text-sm font-medium text-foreground">{user.name}</span>
						<span className="truncate text-xs text-muted-foreground">{user.email}</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuGroup>
					{/* Full navigations, like sign-out: the target pages
					    decide what this account may see. */}
					{patientOnly ? null : (
						<DropdownMenuItem
							onClick={() =>
								window.location.assign(secretary ? "/portal/secretary" : "/portal/doctor")
							}
						>
							{secretary
								? (labels.secretaryPortal ?? "Secretary portal")
								: (labels.doctorPortal ?? "Doctor portal")}
						</DropdownMenuItem>
					)}
					{user.platformAdmin === true ? (
						<DropdownMenuItem onClick={() => window.location.assign("/platform")}>
							{labels.platformConsole ?? "Platform console"}
						</DropdownMenuItem>
					) : null}
					{hasPatientSide ? (
						<DropdownMenuItem onClick={() => window.location.assign("/portal/patient")}>
							{patientOnly
								? (labels.myConsultations ?? "My consultations")
								: (labels.patientPortal ?? "Patient portal")}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					variant="destructive"
					onClick={async () => {
						await signOut();
					}}
				>
					{labels.signOut ?? "Sign out"}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
