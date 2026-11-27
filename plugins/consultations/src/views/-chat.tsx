/**
 * Chat-style transcript primitives — the consultation-workspace redesign
 * (recording screen / detail / review): speaker avatar + bubble rows and
 * the patient context bar. Design-system only: tones come from -ui.ts
 * (speakerTone palette), components from @ktbhealth/ui — no new colors.
 */
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { Badge } from "@ktbhealth/ui/components/badge";

import { speakerNumber, speakerTone } from "./-ui.ts";

/** Badge tones are translucent (`/10` + ring) — the avatar wants a
 * stronger surface. Map each badge tone to a matching solid-ish fill. */
const AVATAR_TONES: Record<string, string> = {
	"bg-info/10 text-info ring-info/20": "bg-info/15 text-info ring-info/30",
	"bg-primary/10 text-primary ring-primary/20": "bg-primary/15 text-primary ring-primary/30",
	"bg-success/10 text-success ring-success/20": "bg-success/15 text-success ring-success/30",
	"bg-warning/10 text-warning ring-warning/20": "bg-warning/15 text-warning ring-warning/30",
	"bg-muted text-muted-foreground ring-border": "bg-muted text-muted-foreground ring-border",
};

/** Initials for the speaker avatar: `SPEAKER_NN` → its number, named
 * roles → first letters of the first two words ("Dr. Emmanuel" → DE). */
export const speakerInitials = (speaker: string): string => {
	const n = speakerNumber(speaker);
	if (n !== null) return `${n}`;
	const words = speaker.trim().split(/\s+/).filter(Boolean);
	return (words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "");
};

/** Circular speaker avatar, tone-matched to the speaker badge. */
export function SpeakerAvatar({ speaker, className }: { speaker?: string; className?: string }) {
	const tone = speaker
		? (AVATAR_TONES[speakerTone(speaker)] ?? AVATAR_TONES[""]!)
		: AVATAR_TONES[""]!;
	return (
		<Avatar className={className}>
			<AvatarFallback className={`text-[10px] font-semibold ring-1 ${tone}`}>
				{speaker ? speakerInitials(speaker).toUpperCase() : "—"}
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * One chat row of the transcript: avatar + header (speaker name,
 * timestamp, role chip) + bubble content. Display/read actions are
 * passed in as `actions` so pages keep their own affordances (seek,
 * edit, verify) — this row owns only the shape.
 */
export function SpeakerChatRow({
	speaker,
	name,
	time,
	roleLabel,
	onSeek,
	actions,
	className,
	bubbleClassName,
	children,
}: {
	/** Raw speaker label (`SPEAKER_NN`/named); undefined = unattributed. */
	speaker?: string;
	/** Display name ("Locutor 1", "Dr. Emmanuel"…). */
	name: string;
	/** mm:ss stamp, shown monospace next to the name. */
	time?: string;
	/** Small role chip ("Médico", "Paciente"); omitted when undefined. */
	roleLabel?: string;
	/** Click on the bubble seeks to this segment. */
	onSeek?: () => void;
	/** Trailing affordances (pencil, check) rendered in the header row. */
	actions?: ReactNode;
	className?: string;
	bubbleClassName?: string;
	children: ReactNode;
}) {
	return (
		<div className={`group flex gap-2.5 ${className ?? ""}`}>
			<SpeakerAvatar speaker={speaker} className="mt-0.5" />
			<div className="min-w-0 flex-1 space-y-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-semibold">{name}</span>
					{time ? (
						<span className="font-mono text-[10px] text-muted-foreground tabular-nums">{time}</span>
					) : null}
					{roleLabel ? (
						<Badge
							variant="secondary"
							className={`text-[9px] ring-1 ${speaker ? speakerTone(speaker) : "bg-muted text-muted-foreground ring-border"}`}
						>
							{roleLabel}
						</Badge>
					) : null}
					{actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
				</div>
				<div
					className={`w-fit max-w-full rounded-2xl rounded-tl-none border bg-card px-3.5 py-2.5 text-sm leading-relaxed ${onSeek ? "cursor-pointer transition-colors hover:bg-muted/60" : ""} ${bubbleClassName ?? ""}`}
					onClick={onSeek}
					role={onSeek ? "button" : undefined}
					tabIndex={onSeek ? 0 : undefined}
					onKeyDown={onSeek ? (e) => (e.key === "Enter" ? onSeek() : undefined) : undefined}
				>
					{children}
				</div>
			</div>
		</div>
	);
}

/**
 * Patient context strip (recording / detail / review pages): avatar,
 * name + metadata, condition chips, and page-supplied actions — the
 * "patient bar" of the workspace redesign. Pure layout; every label is
 * a prop so i18n stays in the pages.
 */
export function PatientContextBar({
	name,
	meta,
	chips,
	actions,
	className,
}: {
	name: string;
	/** Small muted metadata fragments ("42 anos", "Prontuário #4092"). */
	meta?: readonly ReactNode[];
	/** Condition/allergy chips — caller supplies Badges. */
	chips?: ReactNode;
	/** Right-side actions ("Ver Histórico", "Anamnese IA"…). */
	actions?: ReactNode;
	className?: string;
}) {
	const initials = name
		.trim()
		.split(/\s+/)
		.map((w) => w[0])
		.filter(Boolean)
		.slice(0, 2)
		.join("")
		.toUpperCase();
	return (
		<div
			className={`flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2 ${className ?? ""}`}
		>
			<div className="flex min-w-0 items-center gap-3">
				<Avatar>
					<AvatarFallback className="bg-primary/15 text-primary text-[10px] font-semibold ring-1 ring-primary/30">
						{initials || "?"}
					</AvatarFallback>
				</Avatar>
				<div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5">
					<span className="truncate text-xs font-semibold">{name}</span>
					{meta?.map((m, i) => (
						<span key={i} className="flex items-center gap-2.5">
							<span className="text-xs text-muted-foreground">•</span>
							<span className="text-xs text-muted-foreground">{m}</span>
						</span>
					))}
					{chips}
				</div>
			</div>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</div>
	);
}
