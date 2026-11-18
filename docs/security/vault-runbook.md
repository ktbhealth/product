# Vault secrets runbook

Operational guide for `plugins/vault` — the canonical credentials
broker (P-098, ADR-0005). Covers the envelope key hierarchy, routine
operations, and incident response. Audience: platform admins and
whoever is on call.

## Key hierarchy

```
VAULT_MASTER_KEY (KEK, env secret, 32 bytes hex/base64)
  └─ wraps per-row DEK            (wrapped_dek column, AAD: vault-dek:<scope>:<name>)
       └─ encrypts secret value   (ciphertext column, AAD: vault-secret:<scope>:<name>)
```

- `VAULT_MASTER_KEY` is the only deployment secret. It lives in the
  platform secret store / Alchemy env — never in the repo, never in
  the database.
- Each `vault_secret` row has a fresh random DEK. Stealing the
  database yields only wrapped DEKs — useless without the KEK.
- AAD binds both envelopes to `(scope, name)`: ciphertext or DEK
  envelopes copied between rows fail to open (`decrypt-failed`).

## Scopes

| scope           | managed by         | used for                                   |
| --------------- | ------------------ | ------------------------------------------ |
| `platform`      | PlatformAdmin      | deployment-wide creds (SMTP, AI providers) |
| `<tenantId>`    | bound-tenant admin | clinic-owned secrets (vault page UI)       |
| `user:<userId>` | the user themself  | personal credentials (plugins/credentials) |

`resolve(ref)` is server-side only and ungated by design — the
`vault:<id>` ref IS the capability. Every resolve is audit-logged
with actor attribution. Never expose `resolve` over a wire fn.

## Routine operations

### Add / update a secret

- UI: `/portal/<doctor|secretary>/vault` → secrets panel (tenant
  admin), or the platform console for platform scope.
- API: `Secrets.put({ tenantId, name, value, kind, provider, hint })`
  — upserts on `(scope, name)`; `hint` stores a non-secret display
  fragment (e.g. last-4) for masked reads.

### Rotate a secret value

`Secrets.rotate({ id })` re-mints the DEK and re-encrypts the CURRENT
value — the stored plaintext is preserved, `version` bumps,
`rotated_at` stamps. There is no rotate-with-new-value; use `put` for
that (it reseals under a fresh DEK anyway).

### Revoke access

`Secrets.remove({ id })` hard-deletes the row. Consumers holding a
`vault:<id>` ref resolve `null` afterwards — fail-closed by design:
endpoints lose their key, sends fail loudly. Audit the removal
(`vault.secret.remove`).

### Disable without deleting

Set `status = "disabled"` on the row — resolves return `null` while
metadata stays for forensics.

## Incident response

### Suspected secret leak

1. `Secrets.remove({ id })` — kills the ref immediately.
2. Check `admin_audit` for `vault.secret.resolve` rows on that id —
   actor + timestamp of every read-back.
3. Re-issue the credential at the provider, `Secrets.put` the new
   value under the same name — upsert keeps the row id, so existing
   `vault:<id>` refs keep working.
4. If the KEK itself is suspect → see below.

### KEK (`VAULT_MASTER_KEY`) compromise or rotation

The KEK wraps every row DEK. Rotation is a re-wrap ceremony, not a
re-encrypt of values:

1. Generate a new 32-byte key; deploy as `VAULT_MASTER_KEY` (new
   `kekVersion` fingerprint is recorded per row on next write).
2. For each secret: `Secrets.rotate({ id })` — opens under the OLD
   KEK, reseals under the NEW one. **Rotate while the old key is
   still deployed**, or stage: deploy new key alongside old via a
   dual-keyring window (not yet implemented — today rotation requires
   the old key to still unwrap until each row is rotated).
3. Until every row is rotated, the old KEK must remain available —
   there is no bulk re-wrap job yet; script `rotate` over `list` per
   scope.

Until dual-keyring lands, treat KEK rotation as: new key deployed →
rotate all rows promptly → revoke old key. Rows not yet rotated fail
`decrypt-failed` if the old key is pulled early — sequence matters.

### Database dump leaked

Wrapped DEKs + ciphertexts are safe without the KEK — verify
`VAULT_MASTER_KEY` was never in the dump (it is env-only; check
Alchemy secrets, `.env` files, CI logs). If it leaked, follow the KEK
procedure above.

## Failure modes

| symptom                | meaning                           | action                               |
| ---------------------- | --------------------------------- | ------------------------------------ |
| `cipher-unavailable`   | no keyring bound (env missing)    | set `VAULT_MASTER_KEY`, redeploy     |
| `decrypt-failed`       | tampered envelope or wrong KEK    | check audit, re-put the secret       |
| resolve returns `null` | missing/disabled/non-`vault:` ref | check row status + ref spelling      |
| `Forbidden` on writes  | caller lacks scope role           | expected — check tenant binding/role |
| `tenant-mismatch`      | bound tenant ≠ secret scope       | expected cross-tenant guard          |

## What this store is NOT

- Not the ZK record keyring — clinic/device key lifecycle lives in
  `clinic_keys`/`entity_deks`/`portal_keys` (client-side crypto).
- Not env config — `SMTP_URL`, `EMAIL_FROM`, CAPTCHA keys stay
  env-selected drivers (they resolve before plugin services bind).
- Not a place for PHI — secrets are infrastructure credentials.
