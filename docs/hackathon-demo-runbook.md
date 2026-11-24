# Hackathon demo — golden path runbook (T-206)

Target: judges see the magic in <3 min, live, on the deployed URL.
Rehearse on the T-201 deployment before filming T-204/T-196.

## Preconditions

- [ ] Demo URL live and seeded (T-092 patient + synthetic consult exist)
- [ ] Demo doctor account credentials written down (no password manager fumbling live)
- [ ] Backup: T-196 video cued and tested — if live fails, switch immediately
- [ ] Browser: fresh profile or cleared site data; mic permission pre-granted if recording live
- [ ] Fallback input ready: sample/paste transcript (T-193 verified path) if mic/ASR is flaky

## Golden path (~3 min)

1. **Landing** — open demo URL, show product name/tagline (HackBrasil branding, pt-BR UI)
2. **Sign in** — doctor account → consultations dashboard
3. **Consent** — start new consultation, show the consent gate (LGPD story: recording consent before any capture)
4. **Capture** — pick source: `record` (live mic, best demo) or `upload`/`bot` (deterministic fallback)
   - Live: speak a short scripted pt-BR consult (doctor + patient lines, ~60-90s)
   - Fallback: paste/upload the seeded synthetic consult audio
5. **Live transcript** — partial/final hypotheses appear during capture (speaker labels if diarization shows)
6. **Save** — record encrypts + signs client-side (ZK story if asked); server batch transcription + LLM cleanup runs via queue
7. **Review** — open consultation detail: transcript, corrected transcript, 8-section clinical note with verbatim evidence citations
8. **Export** — PDF (`/api/consultations/:id/pdf`) and/or FHIR R4 patient export; mention ZK-gated export caveat if record is encrypted
9. **Pitch beat** — "physician decides, KTB records": evidence citations + pt-BR glossary + measured WER (eval suite, T-164/T-198)

## Failure playbook

| symptom                 | move                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| mic permission/ASR dead | switch to upload/paste source — same downstream path                                         |
| transcript slow         | poll interval is 1.5s/3s; wait one cycle, narrate "processing"                               |
| export 404/gated        | ZK-encrypted records gate PDF export — demo on the seeded non-ZK consult or explain the gate |
| total live failure      | cut to T-196 backup video, keep pitch going                                                  |

## Rehearsal checklist (T-206 exit criteria)

- [ ] Full path executed on deployed URL, timed ≤3 min
- [ ] Every fallback exercised once (upload path, paste path)
- [ ] Export verified on the exact record type used in demo
- [ ] Runbook updated with anything that differed from this draft
