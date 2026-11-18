import type { Confidence } from "@ktb/anamnesis";

export const CONF_STYLE: Record<Confidence, string> = {
	alta: "bg-primary/10 text-primary ring-primary/20",
	media: "bg-warning/10 text-warning ring-warning/20",
	baixa: "bg-muted text-muted-foreground ring-border",
};

export const CONF_BAR: Record<Confidence, string> = {
	alta: "border-l-primary",
	media: "border-l-warning",
	baixa: "border-l-border",
};

export const SPEAKER_STYLE: Record<string, string> = {
	Doctor: "bg-info/10 text-info ring-info/20",
	Patient: "bg-primary/10 text-primary ring-primary/20",
	// legacy pt-BR speaker labels from bot/dictation transcripts
	Médico: "bg-info/10 text-info ring-info/20",
	Paciente: "bg-primary/10 text-primary ring-primary/20",
};

/** Ring-tone classes applied on top of `<Badge variant="secondary">` (see `ring-1`). */
export const BADGE_TONES = {
	neutral: "bg-muted text-muted-foreground ring-border",
	green: "bg-success/10 text-success ring-success/20",
	amber: "bg-warning/10 text-warning ring-warning/20",
	red: "bg-destructive/10 text-destructive ring-destructive/20",
} as const;
