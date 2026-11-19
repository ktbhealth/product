import { paramMessage } from "@ktb/i18n";

/**
 * Dev-capture-test plugin copy, one typed catalog per locale — same
 * contract as plugins/forms/src/i18n.ts: plugins cannot import the
 * host's Paraglide output, so the page resolves strings here from
 * `ctx.locale`. A locale catalog must implement `CaptureTestMessages`
 * in full. The templates mirror the `app.capture_*` keys the host
 * route used (apps/web/messages/*.json) so the spike reads identically.
 */

export const DEV_CAPTURE_TEST_LOCALES = ["en", "pt-BR", "es"] as const;

/** DB namespace this catalog imports into (PL-008 Phase 4). */
export const I18N_NAMESPACE = "dev-capture-test";

/** Locale→messages accessor the baseline importer discovers. */
export const i18nMessagesFor = (locale: string): CaptureTestMessages =>
	devCaptureTestMessages(locale);

export type DevCaptureTestLocale = (typeof DEV_CAPTURE_TEST_LOCALES)[number];
const BASE_LOCALE: DevCaptureTestLocale = "en";

export interface CaptureTestMessages {
	/** Page heading. */
	readonly title: string;
	/** Numbered how-to paragraph under the heading. */
	readonly description: string;
	readonly start: string;
	readonly stop: string;
	/** Status line while getDisplayMedia is pending. */
	readonly statusRequesting: string;
	/** Status line while capturing — params are track label + readyState. */
	readonly statusCapturing: (track: string, state: string) => string;
	/** Error when the shared tab exposes no audio track. */
	readonly errorNoAudio: string;
	/** Level readout — param is the 0–100 percentage, one decimal. */
	readonly level: (level: string) => string;
}

const en: CaptureTestMessages = {
	title: "Spike: tab audio capture",
	description:
		'1. Open a call (WhatsApp Web, Meet, YouTube) in another tab. 2. Click start and select THAT tab with "share audio" enabled. 3. If the meter moves with speech, the path is proven.',
	start: "Start capture",
	stop: "Stop",
	statusRequesting: "requesting tab…",
	statusCapturing: paramMessage("en", "capturing · track: {track} | {state}", ["track", "state"]),
	errorNoAudio: "shared tab has no audio. Enable 'share audio'",
	level: paramMessage("en", "level: {level}%", ["level"]),
};

const ptBR: CaptureTestMessages = {
	title: "Spike: captura de áudio da aba",
	description:
		'1. Abra uma chamada (WhatsApp Web, Meet, YouTube) em outra aba. 2. Clique em iniciar e selecione ESSA aba com "compartilhar áudio" ativado. 3. Se o medidor se mover com a fala, o caminho está provado.',
	start: "Iniciar captura",
	stop: "Parar",
	statusRequesting: "solicitando aba…",
	statusCapturing: paramMessage("pt-BR", "capturando · faixa: {track} | {state}", [
		"track",
		"state",
	]),
	errorNoAudio: "a aba compartilhada não tem áudio. Ative 'compartilhar áudio'",
	level: paramMessage("pt-BR", "nível: {level}%", ["level"]),
};

const es: CaptureTestMessages = {
	title: "Spike: captura de audio de la pestaña",
	description:
		'1. Abra una llamada (WhatsApp Web, Meet, YouTube) en otra pestaña. 2. Haga clic en iniciar y seleccione ESA pestaña con "compartir audio" activado. 3. Si el medidor se mueve con la voz, el camino está probado.',
	start: "Iniciar captura",
	stop: "Detener",
	statusRequesting: "solicitando pestaña…",
	statusCapturing: paramMessage("es", "capturando · pista: {track} | {state}", ["track", "state"]),
	errorNoAudio: "la pestaña compartida no tiene audio. Active 'compartir audio'",
	level: paramMessage("es", "nivel: {level}%", ["level"]),
};

const CATALOGS: Record<DevCaptureTestLocale, CaptureTestMessages> = {
	en,
	"pt-BR": ptBR,
	es,
};

export const isDevCaptureTestLocale = (locale: string): locale is DevCaptureTestLocale =>
	(DEV_CAPTURE_TEST_LOCALES as readonly string[]).includes(locale);

/** Catalog for a locale tag; unknown tags get the base locale. */
export const devCaptureTestMessages = (locale: string | undefined): CaptureTestMessages =>
	CATALOGS[isDevCaptureTestLocale(locale ?? "") ? (locale as DevCaptureTestLocale) : BASE_LOCALE];
