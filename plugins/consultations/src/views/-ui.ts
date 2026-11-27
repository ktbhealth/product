import type { Confidence } from "@ktb/anamnesis";

export const CONF_STYLE: Record<Confidence, string> = {
	alta: "bg-primary/10 text-primary ring-primary/20",
	media: "bg-info/10 text-info ring-info/20",
	baixa: "bg-muted text-muted-foreground ring-border",
};

export const CONF_BAR: Record<Confidence, string> = {
	alta: "border-l-primary",
	media: "border-l-info",
	baixa: "border-l-border",
};

const SPEAKER_STYLE: Record<string, string> = {
	Doctor: "bg-info/10 text-info ring-info/20",
	Patient: "bg-primary/10 text-primary ring-primary/20",
	// legacy pt-BR speaker labels from bot/dictation transcripts
	Médico: "bg-info/10 text-info ring-info/20",
	Paciente: "bg-primary/10 text-primary ring-primary/20",
};

/** Cyclic tones for diarizer labels (P-118): SPEAKER_00→info,
 * SPEAKER_01→primary, then wrap — the number only orders, so
 * consecutive speakers always contrast. */
const SPEAKER_TONES = [
	"bg-info/10 text-info ring-info/20",
	"bg-primary/10 text-primary ring-primary/20",
	"bg-success/10 text-success ring-success/20",
	"bg-warning/10 text-warning ring-warning/20",
] as const;

/** 1-indexed speaker number for `SPEAKER_NN` labels, else null. */
export const speakerNumber = (speaker: string): number | null => {
	const m = /^SPEAKER_(\d+)$/.exec(speaker);
	return m ? Number(m[1]) + 1 : null;
};

/** Badge tone for any speaker label — named speakers keep their
 * semantic color, `SPEAKER_NN` cycles the palette, unknowns go muted. */
export const speakerTone = (speaker: string): string => {
	const named = SPEAKER_STYLE[speaker];
	if (named) return named;
	const n = speakerNumber(speaker);
	if (n !== null) return SPEAKER_TONES[(n - 1) % SPEAKER_TONES.length]!;
	return "bg-muted text-muted-foreground ring-border";
};

/** Ring-tone classes applied on top of `<Badge variant="secondary">` (see `ring-1`). */
export const BADGE_TONES = {
	neutral: "bg-muted text-muted-foreground ring-border",
	green: "bg-success/10 text-success ring-success/20",
	blue: "bg-info/10 text-info ring-info/20",
	red: "bg-destructive/10 text-destructive ring-destructive/20",
} as const;
