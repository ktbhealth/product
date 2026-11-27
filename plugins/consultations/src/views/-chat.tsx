/**
 * Chat-style transcript primitives — the consultation-workspace redesign
 * (recording screen / detail / review): speaker avatar + bubble rows,
 * the patient context bar, the live recording cluster and the anamnesis
 * section cards. Mirrors the approved catalog blocks (storybook
 * `TranscriptChat` / `AnamnesisPanel` / `ConsultationWorkspace`) on
 * design-system primitives — no new colors.
 */
import type { ReactNode } from "react";

import { Avatar, AvatarFallback } from "@ktbhealth/ui/components/avatar";
import { Badge } from "@ktbhealth/ui/components/badge";
import { Bubble, BubbleContent } from "@ktbhealth/ui/components/bubble";
import { Button } from "@ktbhealth/ui/components/button";
import {
	Message,
	MessageAvatar,
	MessageContent,
	MessageHeader,
} from "@ktbhealth/ui/components/message";
import { LockIcon, SquareIcon } from "lucide-react";

import { speakerNumber, speakerTone } from "./-ui.ts";

/** `speakerTone` returns combined badge classes; the avatar and the
 * speaker name want the same hue as separate surfaces. Both maps are
 * keyed on the badge-tone string so every caller stays in sync. */
const AVATAR_TONES: Record<string, string> = {
	"bg-info/10 text-info ring-info/20": "border-info/40 bg-info/15 text-info",
	"bg-primary/10 text-primary ring-primary/20": "border-primary/40 bg-primary/15 text-primary",
	"bg-success/10 text-success ring-success/20": "border-success/40 bg-success/15 text-success",
	"bg-warning/10 text-warning ring-warning/20": "border-warning/40 bg-warning/15 text-warning",
	"bg-muted text-muted-foreground ring-border": "border-border bg-muted text-muted-foreground",
};

const NAME_TONES: Record<string, string> = {
	"bg-info/10 text-info ring-info/20": "text-info",
	"bg-primary/10 text-primary ring-primary/20": "text-primary",
	"bg-success/10 text-success ring-success/20": "text-success",
	"bg-warning/10 text-warning ring-warning/20": "text-warning",
	"bg-muted text-muted-foreground ring-border": "text-muted-foreground",
};

const FALLBACK_BADGE = "bg-muted text-muted-foreground ring-border";

const toneClasses = (map: Record<string, string>, speaker?: string) => {
	const badge = speaker ? speakerTone(speaker) : FALLBACK_BADGE;
	/* v8 ignore next -- every speakerTone output is a map key by construction */
	return map[badge] ?? map[FALLBACK_BADGE]!;
};

const avatarTone = (speaker?: string) => toneClasses(AVATAR_TONES, speaker);
const nameTone = (speaker?: string) => toneClasses(NAME_TONES, speaker);

/** Initials for the speaker avatar: `SPEAKER_NN` → its number, named
 * roles → first letters of the first two words ("Dr. Emmanuel" → DE). */
export const speakerInitials = (speaker: string): string => {
	const n = speakerNumber(speaker);
	if (n !== null) return `${n}`;
	const words = speaker.trim().split(/\s+/).filter(Boolean);
	return (words[0]?.[0] ?? "?") + (words[1]?.[0] ?? "");
};

/** Rounded-box speaker avatar, tone-matched to the speaker palette. */
export function SpeakerAvatar({ speaker, className }: { speaker?: string; className?: string }) {
	return (
		<Avatar className={`size-8 rounded-xl border ${avatarTone(speaker)} ${className ?? ""}`}>
			<AvatarFallback className="rounded-xl text-xs font-bold">
				{speaker ? speakerInitials(speaker).toUpperCase() : "—"}
			</AvatarFallback>
		</Avatar>
	);
}

/**
 * One chat row of the transcript: avatar + header (tone-colored speaker
 * name, timestamp, neutral role chip) + a `Bubble` body. Display/read
 * actions are passed in as `actions` so pages keep their own
 * affordances (seek, edit, verify) — this row owns only the shape.
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
	/** Small neutral role chip ("Médico", "Paciente"); omitted when undefined. */
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
		<Message className={className}>
			<MessageAvatar className="self-start">
				<SpeakerAvatar speaker={speaker} />
			</MessageAvatar>
			<MessageContent>
				<MessageHeader className="mb-1.5 flex items-center gap-2">
					<span className={`text-xs font-bold ${nameTone(speaker)}`}>{name}</span>
					{time ? (
						<span className="font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>
					) : null}
					{roleLabel ? (
						<Badge variant="outline" className="px-1.5 py-0 text-[10px] font-normal">
							{roleLabel}
						</Badge>
					) : null}
					{actions ? <span className="ml-auto flex items-center gap-1">{actions}</span> : null}
				</MessageHeader>
				<Bubble variant="secondary" className="max-w-full">
					<BubbleContent
						className={`w-full rounded-2xl rounded-tl-none border-border/60 px-3.5 py-3 ${
							onSeek ? "cursor-pointer transition-colors hover:bg-muted/60" : ""
						} ${bubbleClassName ?? ""}`}
						onClick={onSeek}
						role={onSeek ? "button" : undefined}
						tabIndex={onSeek ? 0 : undefined}
						onKeyDown={onSeek ? (e) => (e.key === "Enter" ? onSeek() : undefined) : undefined}
					>
						{children}
					</BubbleContent>
				</Bubble>
			</MessageContent>
		</Message>
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
			className={`flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-4 py-2 shadow-sm ${className ?? ""}`}
		>
			<div className="flex min-w-0 items-center gap-3">
				<Avatar className="size-7 border border-primary/40 bg-primary/20">
					<AvatarFallback className="bg-primary/20 text-xs font-bold text-primary">
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
			{actions ? <div className="flex items-center gap-3">{actions}</div> : null}
		</div>
	);
}

/** Centered security note shown above the transcript stream. */
export function EncryptionPill({ children }: { children: ReactNode }) {
	return (
		<div className="my-1 flex items-center justify-center">
			<span className="inline-flex items-center gap-1.5 rounded-full border border-info/30 bg-info/10 px-3 py-1 text-[11px] text-info shadow-sm">
				<LockIcon className="size-2.5" />
				{children}
			</span>
		</div>
	);
}

/** Bottom "listening" status inside the transcript stream. */
export function ListeningIndicator({ children }: { children: ReactNode }) {
	return (
		<div className="flex items-center justify-center gap-2.5 rounded-xl border border-primary/20 bg-card/60 p-3 text-xs text-primary/90 shadow-sm">
			<span className="size-2 animate-ping rounded-full bg-primary" />
			<span className="font-medium italic">{children}</span>
		</div>
	);
}

/** Animated waveform bars for the live recording cluster. */
export function AudioBars({ className }: { className?: string }) {
	return (
		<span className={`flex h-3 items-center gap-0.5 ${className ?? ""}`} aria-hidden>
			{[0, 0.15, 0.3, 0.45].map((delay) => (
				<span
					key={delay}
					className="w-0.5 animate-[recbar_1.2s_ease-in-out_infinite] rounded-full bg-destructive"
					style={{ animationDelay: `${delay}s`, height: "8px" }}
				/>
			))}
			<style>{`@keyframes recbar { 0%,100% { height: 6px } 50% { height: 14px } }`}</style>
		</span>
	);
}

/**
 * Recording cluster for the transcript header: pulsing dot + mono
 * elapsed timer + wave bars + a stop button (the recorder exposes no
 * pause, so the affordance is stop-only).
 */
export function RecordingIndicator({
	elapsed,
	onStop,
	stopLabel,
}: {
	elapsed: string;
	onStop?: () => void;
	stopLabel?: string;
}) {
	return (
		<div className="flex items-center gap-2 rounded-lg border bg-card px-2.5 py-1">
			<span className="size-2 animate-pulse rounded-full bg-destructive" />
			<span className="font-mono text-xs font-bold tabular-nums">{elapsed}</span>
			<AudioBars />
			{onStop ? (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-6"
					onClick={onStop}
					aria-label={stopLabel}
					title={stopLabel}
				>
					<SquareIcon className="size-3" />
				</Button>
			) : null}
		</div>
	);
}

/**
 * Transcript panel header (approved layout): live/static status dot +
 * uppercase title on the left, page-supplied controls on the right.
 */
export function TranscriptPanelHeader({
	live = false,
	title,
	children,
}: {
	live?: boolean;
	title: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex shrink-0 items-center justify-between gap-2 border-b bg-card/60 px-4 py-2.5">
			<div className="flex min-w-0 items-center gap-2">
				<span
					className={`size-2 shrink-0 rounded-full ${
						live ? "animate-pulse bg-primary" : "bg-muted-foreground/40"
					}`}
				/>
				<h2 className="truncate text-xs font-bold tracking-wider uppercase">{title}</h2>
			</div>
			{children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
		</div>
	);
}

/**
 * Anamnesis section card (approved layout): colored dot + uppercase
 * title + right-side status chip over a bordered body. Pages decide the
 * status (confidence badge, edited tag…) and the body (text, textarea,
 * evidence list).
 */
export function AnamnesisSection({
	title,
	status,
	accent = "bg-primary",
	className,
	children,
}: {
	title: string;
	status?: ReactNode;
	/** Dot color — token utility like `bg-primary` / `bg-info`. */
	accent?: string;
	className?: string;
	children: ReactNode;
}) {
	return (
		<section className={`rounded-xl border bg-card p-3.5 ${className ?? ""}`}>
			<div className="mb-1.5 flex items-center justify-between gap-2">
				<div className="flex min-w-0 items-center gap-2">
					<span className={`size-1.5 shrink-0 rounded-full ${accent}`} />
					<h3 className="truncate text-xs font-bold tracking-wide uppercase">{title}</h3>
				</div>
				{status}
			</div>
			<div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
		</section>
	);
}
