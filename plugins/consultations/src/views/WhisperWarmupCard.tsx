import { useEffect, useState } from "react";
import { AudioLinesIcon, CheckIcon, CircleAlertIcon, XIcon } from "lucide-react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { TranscriptionBackend, TranscriptionEngineMessage } from "@ktb/transcription";

import { Button } from "@ktbhealth/ui/components/button";
import { Card, CardContent } from "@ktbhealth/ui/components/card";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { consultationMessages, I18N_NAMESPACE } from "../i18n.ts";

/**
 * localStorage flag for the one-time dismissal — device-local on
 * purpose: the Whisper weights it warms are cached per browser
 * (transformers.js Cache API), so "already handled" is a per-device
 * fact. There is no per-user UI-preference store in the registry, and
 * plugin_state is enable-state, not user state.
 */
export const WHISPER_WARMUP_DISMISSED_KEY = "ktb.consultations.whisperWarmup.dismissed";

type WarmupPhase = "idle" | "loading" | "ready" | "error";

/** Engine-level failures only — `error` messages carrying an `id` are
 * per-chunk transcription errors, not load failures (same rule the
 * consult page applies). */
const isEngineMessage = (m: TranscriptionEngineMessage): boolean => m.type !== "error" || !m.id;

/**
 * Doctor-portal warm-up card (the onboarding equivalent — the product
 * has no multi-step onboarding flow, so this is the one-time prompt on
 * the clinical home): fires `backend.load()` in the background so the
 * ~50 MB Whisper download overlaps whatever the doctor does next,
 * instead of landing inside the first real consultation. transformers.js
 * keeps the weights in the browser Cache API, so the consult page's
 * lazy `load()` resolves fast afterwards — it stays the fallback for
 * doctors who never saw or dismissed this card.
 *
 * Fire-and-forget by contract: mounting never blocks, `load()` is
 * idempotent, and every state (downloading status text, ready, error +
 * retry) renders honestly from the engine's own messages. Dismissal is
 * persisted per device; non-whisper backends (webSpeech last-resort)
 * render nothing.
 */
export function WhisperWarmupCard({
	backend,
	driverId,
	i18n,
	locale = "en",
}: {
	backend: TranscriptionBackend;
	/** `transcriptionDriverId` from ../backend.ts — the card only makes
	 * sense when the resolved engine actually downloads a model. */
	driverId: string | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	/** Active UI locale, injected by the host. */
	locale?: string;
}) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, consultationMessages(locale));
	const w = t.warmup;
	// `mounted` doubles as the visibility flag: driverId and
	// localStorage are client-only, so the SSR pass and the first
	// client render both emit nothing — no hydration drift. The mount
	// effect flips it once eligibility + dismissal are known.
	const [mounted, setMounted] = useState(false);
	const [phase, setPhase] = useState<WarmupPhase>("idle");
	const [detail, setDetail] = useState<string | null>(null);
	const [device, setDevice] = useState<string | null>(null);

	useEffect(() => {
		if (driverId !== "whisper") return;
		if (window.localStorage.getItem(WHISPER_WARMUP_DISMISSED_KEY) === "1") return;
		setMounted(true);
		const off = backend.subscribe((m) => {
			if (!isEngineMessage(m)) return;
			if (m.type === "progress") {
				setPhase("loading");
				setDetail(m.message ?? null);
			}
			if (m.type === "ready") {
				setPhase("ready");
				setDevice(m.device ?? null);
				setDetail(null);
			}
			if (m.type === "load-failed") setPhase("error");
			if (m.type === "error") {
				setPhase("error");
				setDetail(m.message ?? null);
			}
		});
		// Reflect a load already in flight (e.g. a consult page visited
		// earlier in this tab) instead of flashing "idle".
		const st = backend.status();
		if (st.state === "ready") {
			setPhase("ready");
			setDevice(st.device);
		} else if (st.state === "loading") {
			setPhase("loading");
		}
		// Kick the download now — overlaps whatever the doctor does on
		// the portal home; never awaited, never blocks the page.
		backend.load();
		return off;
	}, [backend, driverId]);

	if (!mounted) return null;

	const dismiss = () => {
		try {
			window.localStorage.setItem(WHISPER_WARMUP_DISMISSED_KEY, "1");
		} catch {
			// storage unavailable (private mode quota) — hide for this
			// mount anyway; worst case the card returns next visit.
		}
		setMounted(false);
	};

	const retry = () => {
		setPhase("loading");
		setDetail(null);
		backend.load();
	};

	return (
		<Card className="border-primary/20 bg-primary/5">
			<CardContent className="flex items-start gap-3 p-4">
				<span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
					<AudioLinesIcon className="size-4" />
				</span>
				<div className="min-w-0 flex-1">
					<p className="text-sm font-semibold">{w.title}</p>
					<p className="mt-0.5 text-xs text-muted-foreground">{w.description}</p>
					<div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
						{phase === "ready" ? (
							<span className="flex items-center gap-1.5 text-primary">
								<CheckIcon className="size-3.5" />
								{w.ready(device)}
							</span>
						) : phase === "error" ? (
							<span className="flex items-center gap-1.5 text-destructive">
								<CircleAlertIcon className="size-3.5" />
								{w.failed(detail ?? "")}
							</span>
						) : (
							<span className="flex items-center gap-1.5 text-muted-foreground">
								<Spinner className="size-3.5" />
								{detail ?? w.preparing}
							</span>
						)}
						{phase === "error" ? (
							<Button variant="outline" size="sm" className="h-6 px-2 text-xs" onClick={retry}>
								{w.retry}
							</Button>
						) : null}
					</div>
				</div>
				<Button
					variant="ghost"
					size="icon"
					className="size-7 shrink-0"
					aria-label={w.dismiss}
					onClick={dismiss}
				>
					<XIcon className="size-3.5" />
				</Button>
			</CardContent>
		</Card>
	);
}
