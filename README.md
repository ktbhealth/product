# KTB

> KTB turns medical conversations into lasting clinical knowledge.

KTB is a documentation platform for doctors: it captures the
consultation audio, transcribes it, and drafts a structured clinical
anamnesis. The physician reviews, edits, and approves — KTB never
diagnoses or recommends treatment.

Two audiences: doctors work in the consult flow today; patients get
their own read-only surfaces (visit summaries, shared history) as
those features land.

## Problem

Doctors spend ~40% of a consult documenting instead of listening.
Existing EMRs make it worse: the physician types looking at the
screen, not the patient.

## Run

```bash
bun install
bun run dev         # http://localhost:3000 — stub auth/captcha, no secrets needed
bun run dev:node    # same app on plain Node + SQLite file (no workerd)
bun run dev:secrets # real secrets via cuora vault (needs access)
bun run check       # fmt + lint + typecheck
bun run test        # vitest, per-package
bun run build       # production build
bun run deploy      # Cloudflare via alchemy (needs vault access)
```

`DATABASE_URL` picks the SQLite file under `dev:node`
(default `./data/app.db`).

### Run locally end-to-end (no external services)

Everything the golden path needs is stubbed by default — AI
(`AI_STUB=1` returns a canned pt-BR consult transcript that the
heuristic anamnesis extractor turns into a populated note), email
(`EMAIL_STUB=1` logs messages), captcha (`CAPTCHA_STUB=1`), and the
queue/R2/D1 bindings (local workerd or SQLite under `dev:node`). The
recommended path is plain Node + SQLite — no workerd needed:

```bash
bun install                  # "Blocked 1 postinstall" for
                             # onnxruntime-node is expected (evals only)
bun run db:seed -- --sqlite  # dev accounts into the dev:node SQLite
                             # file (migrations applied automatically)
bun run dev:node             # first page takes ~1 min while deps optimize
```

Workerd alternative (local D1/R2/queues, closer to prod):

```bash
bun install
bun run dev              # then, once:
bun run db:migrate:local # apply D1 migrations to the local state
bun run db:seed          # dev accounts into local D1 (idempotent)
```

If `bun run dev` fails at startup on your machine, stick with
`dev:node` — same stubs, same seeded accounts.

Sign in as `user@ktb.test` / `dev-password-123` (seeded doctor; see
`apps/web/scripts/seed-users.ts` for the other accounts). Without the
seed, sign up through the UI instead — `EMAIL_STUB` prints the
verification link to the server log.

To exercise real models instead of the AI stub, set `AI_STUB=0` and
`AI_BASE_URL=http://localhost:8080/v1` (OpenAI-compatible:
`/audio/transcriptions` + `/chat/completions`) in `apps/web/.dev.vars`
for `bun run dev`, or as env vars for `dev:node`.

## Layout

- `apps/web` — the app (TanStack Start on Cloudflare Workers)
- `plugins/` — features as plugins: consultations, patients,
  pages, manager, etc. Each contributes routes, nav, pages, and UI;
  plugins can be toggled at runtime under `/platform/plugins`
- `packages/` — shared infrastructure (db, auth, transcription,
  anamnesis, plugin kernel)
- `infra/` — Cloudflare deployment (alchemy)

## Notes

- Plugin architecture: everything user-facing is a plugin
  contribution; `plugins/` depends on `packages/`, never the reverse.
  Details in `AGENTS.md`.
- v0 is deployed to Cloudflare Workers. Roadmap and ADRs live on the
  [`project`](https://github.com/ktbhealth/project) board.
- Related: [`ui`](https://github.com/ktbhealth/ui) design system,
  [`docs`](https://github.com/ktbhealth/docs) documentation site.
