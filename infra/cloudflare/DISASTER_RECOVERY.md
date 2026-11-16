# Disaster recovery — Cloudflare deployment

Availability and restore procedures for the KTB Health production stack
(PL-007 F4 / T-150). Read the whole document before an incident — the
last section explains why a perfect infrastructure restore can still
yield zero readable records under the zero-knowledge model.

## Resource inventory

All stateful resources are provisioned by Alchemy
(`apps/web/alchemy.run.ts`, stack `ktb-web`, stage `prod`). Physical
names carry a random suffix — resolve them before operating:

```sh
bunx wrangler d1 list --json            # ktb-web-db-prod-<suffix>
bunx wrangler r2 bucket list            # ktb-web-audio-prod-<suffix>
bunx wrangler queues list               # ktb-web-transcription-prod-<suffix>
```

| Resource              | Contents                                                                           | Durability story                                                                 |
| --------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D1 `db`               | All record rows, auth tables, plugin state. Under ZK: ciphertext + authz metadata. | Time Travel (always on) + on-demand SQL export                                   |
| R2 `audio`            | Consultation audio blobs. Under ZK: client-encrypted ciphertext.                   | Durably replicated by R2; no PITR/versioning — external copy only                |
| Queue `transcription` | In-flight transcription jobs                                                       | Not backed up; at-least-once delivery re-executes                                |
| Secrets               | cuora vault → worker bindings (`infra:deploy`)                                     | Re-injected on every deploy; vault is its own backup                             |
| Alchemy state         | Resource ids/suffixes                                                              | Re-resolvable from the Cloudflare account; state loss is recoverable by adoption |

## D1 — Time Travel (point-in-time recovery)

Time Travel is **always on** — there is nothing to enable in Alchemy or
the dashboard. The Alchemy `D1.Database` resource has no backup prop
because none exists upstream. Retention is **30 days** on the Workers
Paid plan and **7 days** on Free — confirm which plan the account is on,
because that number is the recovery window for every scenario below.

Pre-flight check (run once, record in ops notes):

```sh
bunx wrangler d1 info <db-name>
# `version: production` = new storage subsystem, Time Travel works.
# `version: alpha`     = legacy snapshots only — flag to the team.
```

### Restore procedure

1. Identify the target point — a Unix timestamp or RFC3339 string.
2. Look up the bookmark for that time:

   ```sh
   bunx wrangler d1 time-travel info <db-name> --timestamp="2026-11-20T12:00:00Z"
   ```

3. Capture the **current** bookmark first — it is the undo path:

   ```sh
   bunx wrangler d1 time-travel info <db-name> --json
   ```

4. Restore:

   ```sh
   bunx wrangler d1 time-travel restore <db-name> --timestamp=<ts>
   # or --bookmark=<bookmark>
   ```

5. To undo, restore to the bookmark captured in step 3. Restoring does
   **not** delete older bookmarks — you can walk backwards again.

Gotchas:

- Restore is destructive and in-place; in-flight queries are cancelled.
- Time Travel cannot fork/clone a database — recovery is a rollback, not
  a branch. For postmortem data inspection, export first (below), then
  restore.
- Bookmarks advance on Cloudflare internal maintenance without writes —
  verify state by row counts, not bookmark freshness.

## D1 — logical export (retention beyond 30 days)

Time Travel expires; a SQL dump does not.

```sh
bunx wrangler d1 export <db-name> --remote --output ktb-db-<date>.sql
```

For scheduled exports, the Alchemy Cloudflare provider also ships
`exportDatabase` (REST export → signed download URL), and Cloudflare
documents a Workflows → R2 pattern for periodic dumps. No schedule is
wired yet — see "Open decisions" below.

## R2 `audio` — posture and limits

Configured in `apps/web/alchemy.run.ts`:

- **Lifecycle rule `abort-incomplete-multipart-uploads`** — multipart
  uploads stranded for over 7 days are aborted (they bill storage and
  can hold the bucket non-empty on destroy).
- **No object locks** — R2 bucket locks (`Bucket.locks` in Alchemy) are
  available but any lock would also block the purge path that runs when
  a consultation is deleted. Enabling locks is a retention-policy
  decision, not a default — see "Open decisions".
- **No versioning / no PITR on R2** — object restores are impossible
  inside Cloudflare. The recovery path is an external copy:

  ```sh
  # Any S3-compatible tool with R2 credentials:
  aws s3 sync s3://<bucket> ./audio-backup/ --endpoint-url \
    https://<account-id>.r2.cloudflarestorage.com
  ```

  Under ZK the objects are client-encrypted, so an external copy leaks
  nothing and needs no extra protection beyond access control.

- R2 itself is the durability layer (erasure-coded across the region);
  the scenarios that actually lose objects are operator deletes and
  accidental purges — hence the purge-vs-lock tension above.

## Queues

In-flight transcription jobs are transient: the consumer (`maxRetries: 3`)
re-delivers, and a job's inputs (D1 row + R2 object) are what matter.
After a D1 restore, verify no row sits in `audio_status = 'processing'`
forever — re-enqueue via the admin path if needed.

## Per-tenant export (ciphertext backup)

`apps/web/scripts/export-tenant.mjs` dumps one tenant's rows plus its
R2 audio objects:

```sh
cd apps/web
node scripts/export-tenant.mjs --tenant <groups.id>
# → tenant-<id>-export-<ts>/
#     manifest.json   row counts, audio file list, D1 bookmark at export
#     db/<table>.json one file per tenant-scoped table
#     audio/<file>    R2 objects for the tenant's consultations
```

This is the clinic-level "my data" story under ZK: the archive is pure
ciphertext, safe to hand to the clinic or store off-platform, and it
captures the D1 bookmark so a restore can later be aligned to it.
**Caveat:** the script enumerates today's tenant-scoped tables — when
`clinic_keys`/`entity_deks` land (F2), they must be added to
`TENANT_TABLES` or a restored tenant loses the very key material that
makes its ciphertext useful.

## Ciphertext-only recovery — read before restoring

Under the ZK model the server never holds plaintext or the keys to make
it. Consequences:

- **A restored database is ciphertext.** Recovery succeeds when the
  _ciphertext_ is back — decryption is a client-side concern exercised
  by clinic devices on next login.
- **`clinic_keys` / `entity_deks` restore with the DB.** Time Travel
  rolls key-wrap rows back together with records, so a restored tenant
  can still unwrap its DEKs as long as member devices hold their keys.
- **The real recovery asset is the clinic recovery phrase.** It encodes
  the clinic master key and is held by the clinic (printable, F2). A
  lost master key with no surviving member device means the records are
  **unrecoverable by design** — no admin, deploy, or Cloudflare support
  path changes that. This is the core ZK guarantee, not a gap.
- A D1 restore cannot resurrect a clinic whose master key is gone; it
  only restores the wrapped material. Key continuity across member
  changes is the re-wrap ceremony (`docs/zk/dek-rewrap-ceremony.md`).

## Restore drill (quarterly)

1. `wrangler d1 export` a copy; stash it outside the repo.
2. Pick a timestamp 1 hour back; Time-Travel restore; spot-check row
   counts on `patients`, `consultations`.
3. Undo via the pre-restore bookmark.
4. Run `export-tenant.mjs --tenant <test-clinic>` against a non-prod
   stage; verify manifest row counts match the dashboard.
5. Record drill date, duration, and findings in `repos/project`.

## Open decisions

- **Scheduled whole-DB export to R2** (Workflows pattern) — needed only
  if >30-day audit retention is required; otherwise Time Travel +
  on-demand export covers it.
- **R2 object locks** — enable only with a retention policy that
  tolerates blocking the delete/purge path.
- **Off-platform backup cadence** for `audio` — external S3 sync has no
  schedule yet.
- **Who owns the recovery phrase custody** at each clinic — operational,
  not technical, but it determines whether "lost key" is a drill or an
  incident.
