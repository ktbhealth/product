import { useRef, useState } from "react";

import type { PageBeforeLoad, PageContext } from "@ktb/kernel";

import { devCaptureTestMessages } from "./i18n.ts";

/**
 * Dev-only gate for `/capture-test`, ported from the host route's
 * `beforeLoad` (apps/web/src/routes/capture-test.tsx): the Playwright
 * e2e boots `vp dev`, so the check passes locally and fails closed to
 * not-found in production builds. `import.meta.env.DEV` is a Vite
 * compile-time constant in BOTH the SSR and client bundles — the hook
 * runs on both dispatchers (the root `/$` splat invokes it on server
 * renders and client navigations alike), so the page never mounts
 * outside development. Lives in this client-safe module so
 * ./client.ts can share the exact same reference (parity is asserted
 * by apps/web/src/plugins.test.ts).
 */
export const devCaptureTestBeforeLoad: PageBeforeLoad = () =>
	import.meta.env.DEV ? undefined : { notFound: true };

/**
 * `/capture-test` — dev-only spike (T-012) proving that tab audio
 * (e.g. a WhatsApp Web call) is capturable via getDisplayMedia. Ported
 * verbatim from the host route apps/web/src/routes/capture-test.tsx;
 * copy now resolves from this plugin's i18n catalog (`ctx.locale`)
 * instead of the host's `app.*` Paraglide slice. The descriptor's
 * `beforeLoad`/`guard` keep it dev-only — this component assumes it
 * only ever mounts under `import.meta.env.DEV`.
 */
export const CaptureTestPage = ({ ctx }: { data: unknown; ctx: PageContext }) => {
	const messages = devCaptureTestMessages(ctx.locale);
	const [level, setLevel] = useState(0);
	const [status, setStatus] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const refs = useRef<{
		stream?: MediaStream;
		ctx?: AudioContext;
		raf?: number;
	}>({});

	async function start() {
		setError(null);
		setStatus(messages.statusRequesting);
		try {
			const stream = await navigator.mediaDevices.getDisplayMedia({
				video: true,
				audio: { echoCancellation: false, noiseSuppression: false },
			});
			for (const track of stream.getVideoTracks()) track.stop();
			const audioTrack = stream.getAudioTracks()[0];
			if (!audioTrack) {
				setError(messages.errorNoAudio);
				return;
			}
			refs.current.stream = stream;
			const audioCtx = new AudioContext();
			refs.current.ctx = audioCtx;
			const src = audioCtx.createMediaStreamSource(stream);
			const analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			src.connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);
			setStatus(messages.statusCapturing(audioTrack.label, audioTrack.readyState));

			const tick = () => {
				analyser.getByteTimeDomainData(data);
				let sum = 0;
				for (const v of data) sum += (v - 128) ** 2;
				setLevel(Math.sqrt(sum / data.length) / 128);
				refs.current.raf = requestAnimationFrame(tick);
			};
			tick();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	}

	function stop() {
		if (refs.current.raf) cancelAnimationFrame(refs.current.raf);
		for (const t of refs.current.stream?.getTracks() ?? []) t.stop();
		void refs.current.ctx?.close();
		setLevel(0);
		setStatus(null);
	}

	return (
		<div>
			<h1 className="text-2xl font-bold">{messages.title}</h1>
			<p className="mt-2 text-sm text-muted-foreground">{messages.description}</p>
			<div className="mt-6 flex gap-2">
				<button
					type="button"
					onClick={start}
					className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/80"
				>
					{messages.start}
				</button>
				<button
					type="button"
					onClick={stop}
					className="rounded-lg border border-border px-4 py-2 text-sm"
				>
					{messages.stop}
				</button>
			</div>
			{status ? <p className="mt-3 text-xs text-muted-foreground">{status}</p> : null}
			{error ? <p className="mt-3 text-xs text-destructive">{error}</p> : null}
			<div className="mt-6 h-6 w-full overflow-hidden rounded bg-muted">
				<div
					className="h-full bg-primary transition-[width] duration-75"
					style={{ width: `${Math.min(100, level * 400)}%` }}
				/>
			</div>
			<p className="mt-1 text-xs text-muted-foreground">
				{messages.level((level * 100).toFixed(1))}
			</p>
		</div>
	);
};
