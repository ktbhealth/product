# Hackathon demo — golden path runbook (T-206)

Target: judges see the magic in <3 min, live, on the deployed URL.
Rehearse on the T-201 deployment before filming T-204/T-196.

> **Rehearsed locally on `dev:node` (T-206, 2026-11-25):** the full golden
> path below was executed end-to-end against `bun run dev:node` with the
> AI/email/captcha stubs — scripted browser run took ~15 s warm. Verified
> commands and divergences are in "Local rehearsal (dev:node)".

## Preconditions

- [ ] Demo URL live and seeded (T-092 patient + synthetic consult exist —
      **gap found:** `db:seed` creates accounts + 2 patients but **no
      consultations**; seed or create the demo consult before the event)
- [ ] Demo doctor account credentials written down (no password manager fumbling live)
- [ ] Backup: T-196 video cued and tested — if live fails, switch immediately
- [ ] Browser: fresh profile or cleared site data; mic permission pre-granted if recording live
- [ ] Fallback input ready: sample/paste transcript (T-193 verified path) if mic/ASR is flaky
- [ ] pt-BR UI: locale comes from the `ktb-locale` cookie or `?locale=pt-BR`
      — default is English. Set the cookie once on the demo browser.

## Golden path (~3 min)

1. **Landing** — open demo URL, show product name/tagline (HackBrasil branding, pt-BR UI)
2. **Sign in** — doctor account → consultations dashboard
   (`/consultations` 307-redirects to `/portal/doctor/consultations`)
3. **Consent** — `/portal/doctor/consultations/new`: check the consent
   declaration (LGPD story: consent recorded server-side on save —
   `consent_at` is written by `recordConsentFn`), pick/create the patient
4. **Capture** — pick source: `record` (live mic, best demo) or
   `upload`/`bot` (deterministic fallback)
   - Live: speak a short scripted pt-BR consult (doctor + patient lines, ~60-90s)
   - Fallback: **"Use sample"** button pastes a canned pt-BR transcript
     (verified — no audio needed), or upload a wav via the Upload tab
5. **Live transcript** — partial/final hypotheses appear during capture (speaker labels if diarization shows)
6. **Save** — record encrypts + signs client-side under ZK tenants; server
   batch transcription + LLM cleanup runs via queue. Poll cadence is
   1.5 s for live-bot transcript, 3 s (+3 settle polls) for the audio
   pipeline — verified in `views/-transcript.tsx` / `NewConsultationPage.tsx`
7. **Review** — open consultation detail: transcript, corrected transcript,
   8-section clinical note (`SECTION_LABELS` in `@ktb/anamnesis`) with
   verbatim evidence citations
8. **Export** — PDF `GET /api/consultations/:id/pdf` (verified: 200
   `application/pdf`) and FHIR R4 / OpenEHR via
   `GET /api/patients/:id/export?format=fhir-r4|openehr` (verified: 200
   Bundle; bad format → 400). ZK-encrypted records gate PDF export
   (`exportLocked` message) — demo on a non-ZK consult or explain the gate
9. **Pitch beat** — "physician decides, KTB records": evidence citations + pt-BR glossary + measured WER (eval suite, T-164/T-198)

## Local rehearsal (dev:node) — verified commands

Zero-config local path (PR #313): AI, email and captcha are stubbed;
SQLite lives at `apps/web/data/app.db`. `bun run dev` (workerd) is
currently broken — use `dev:node` only (T-225 tracks the fix).

```bash
git clone https://github.com/ktbhealth/product.git && cd product
bun install
bun run db:seed -- --sqlite   # accounts: user@ktb.test etc, pw dev-password-123
bun run dev:node              # http://localhost:3000 — first page compile ~10-70 s/route
```

Verified against a live `dev:node` server:

```bash
# sign in (better-auth; origin header required)
curl -c cj.txt -X POST http://localhost:3000/api/auth/sign-in/email \
  -H 'content-type: application/json' -H 'origin: http://localhost:3000' \
  -d '{"email":"user@ktb.test","password":"dev-password-123"}'
# → 200 + session cookie; /api/auth/get-session returns the session

# pages (curl follows the 307s)
curl -b cj.txt -o /dev/null -w '%{http_code}\n' http://localhost:3000/portal/doctor/consultations/new   # 200

# consultation detail page, PDF, FHIR — all verified 200 after UI save
curl -b cj.txt -o consult.pdf -w '%{http_code} %{content_type}\n' \
  http://localhost:3000/api/consultations/1/pdf          # 200 application/pdf
curl -b cj.txt 'http://localhost:3000/api/patients/1/export?format=fhir-r4'   # 200 Bundle
curl -b cj.txt 'http://localhost:3000/api/patients/1/export?format=openehr'   # 200

# audio pipeline (raw body or multipart; owner-only)
curl -b cj.txt -X POST http://localhost:3000/api/consultations/1/audio \
  -H 'content-type: audio/wav' --data-binary @tone.wav    # 200 {audioStatus:"queued"}
# → audio_status flips queued→done in ~3 s (in-process SQLite queue);
#   server_transcript = canned pt-BR stub transcript
curl -b cj.txt -o dl.wav -w '%{http_code}\n' http://localhost:3000/api/consultations/1/audio  # 200

# synchronous transcribe (multipart field "audio")
curl -b cj.txt -X POST http://localhost:3000/api/transcribe \
  -F 'audio=@tone.wav;type=audio/wav'                     # 200 {"text": "<stub pt-BR transcript>"}
```

UI path verified via Playwright (headless Chromium): sign-in → dashboard →
`/portal/doctor/consultations/new` → consent checkbox → patient select →
"Use sample" → "Generate anamnesis →" (stub = instant) → "Save
consultation" → success dialog "View consultation" → detail page with
anamnesis → PDF/FHIR. `consent_at` and `patient_id` confirmed written.

### Rehearsal findings / caveats

- **Whisper load is lazy (T-255)**: the ~50 MB+ onnxruntime-web model
  only downloads when a capture actually starts (`backend.load()` inside
  mic/tab/dictation start), or ahead of time via the warm-up card on
  `/portal/doctor` — it OOM'd a constrained headless browser once during
  rehearsal. The paste/sample, upload and bot paths never touch the
  client model. If demoing a live capture on a slow connection, start
  the mic once beforehand so the download overlaps the permission
  prompt instead of the first words.
- **Cold-compile latency is dev-only**: each route's first hit costs
  ~10-70 s under `vp dev`; subsequent hits are ~1-4 s. Hit every demo
  route once before showtime (does not apply to the deployed build).
- **Seed gap (T-092)**: `db:seed` creates 6 accounts + 2 patients
  (`Patient`, `Child of Guardian`) and **zero consultations** — the
  "synthetic consult" the runbook assumes does not exist yet.
- **Locale**: UI defaults to English; pt-BR needs `?locale=pt-BR` or the
  `ktb-locale=pt-BR` cookie (there is a locale switcher in the app).
- **ZK export gate**: PDF export is disabled with "PDF export unavailable
  for encrypted records" for ZK-ciphered consultations — verified in code
  (`ConsultationDetailPage`); the rehearsal record was non-ZK so export
  worked. Keep the demo consult non-ZK or narrate the gate.
- **Upload path**: `POST /api/consultations/:id/audio` accepts a raw
  `audio/*` body or multipart `audio` field; any non-empty `audio/*`
  payload clears validation (the stub ignores content). A 3 s 16 kHz mono
  wav verified end-to-end.

## Failure playbook

| symptom                 | move                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| mic permission/ASR dead | switch to upload/paste source — same downstream path                                         |
| transcript slow         | poll interval is 1.5s/3s; wait one cycle, narrate "processing"                               |
| export 404/gated        | ZK-encrypted records gate PDF export — demo on the seeded non-ZK consult or explain the gate |
| total live failure      | cut to T-196 backup video, keep pitch going                                                  |

## Rehearsal checklist (T-206 exit criteria)

- [x] Full path executed locally on `dev:node` (scripted, ~15 s warm; UI-only steps: live mic, karaoke/diarization labels, bot join — underlying APIs verified)
- [x] Every fallback exercised once (upload path via wav POST, paste path via "Use sample")
- [x] Export verified on the exact record type used in demo (non-ZK consult → PDF + FHIR + OpenEHR all 200)
- [x] Runbook updated with anything that differed from this draft
- [ ] Full path executed on deployed URL, timed ≤3 min (pending T-201 deployment)

## Freeze checklist (T-205, Nov-29)

- [ ] Demo URL live, seeded (incl. the synthetic consult — T-092 gap), and stable through the freeze window
- [ ] Backup video (T-196) cued and tested — switch immediately on live failure
- [ ] Submission form complete (all fields, links, team info)
- [ ] Repo public (`github.com/ktbhealth/product`) and readable without auth
- [ ] Freeze window respected: no merges to `main` during the freeze unless demo-critical
