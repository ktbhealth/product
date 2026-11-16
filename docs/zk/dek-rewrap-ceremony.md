# DEK re-wrap ceremony — member revocation

Spec for the zero-knowledge key-continuity ceremony that runs when a
clinic member (or one of their devices) is revoked (PL-007 F4 / T-150).
The implementing code lands with the clinic keyring (`plugins/vault`,
F2) and `@ktb/crypto` — this document is the contract that code must
satisfy. Nothing here runs on the server beyond row bookkeeping: the
server holds no key material and can only delete rows, never re-wrap.

## Key layout (context)

- `clinic_keys` — one entry per approved member device: the clinic
  master key wrapped (ECIES: ECDH P-256 + HKDF-SHA-256 → AES-256-GCM)
  to that device's public key.
- `entity_deks` — per-record AES-256-GCM DEK, one wrapped copy per
  authorized reader (member device pubkey; patient pubkey for portal
  grants).
- Members unwrap their `clinic_keys` entry locally → clinic master key
  → then unwrap any `entity_deks` copies addressed to them.

## Trigger

Any of:

1. Clinic admin revokes a member (`group_members` row removed).
2. A member revokes one of their own devices (compromise/loss).
3. Clinic master key rotation (scheduled or post-incident).

Triggers 1–2 run the **revocation ceremony**; trigger 3 runs the
**rotation ceremony** — same mechanics, different reason code.

## Preconditions

- At least one **remaining member device** can still unwrap the clinic
  master key (a surviving `clinic_keys` entry whose device private key
  is available). If the last key-holding member is revoked, the
  clinic's records are unrecoverable by design — the UI must hard-block
  that revocation unless a recovery phrase re-import path exists.
- The acting device is an approved member device of the same tenant.

## Revocation ceremony

Performed **client-side on a remaining admin device** (server can never
do this — it holds ciphertext only). Steps:

1. **Revoke (server).** Delete the member's `group_members` row and
   their `clinic_keys` wrap entries. The revoked member can no longer
   fetch new wraps — this alone cuts off _future_ access.
2. **Flag (server).** Every `entity_deks` copy addressed to the revoked
   member's devices is deleted (server-side row delete — ciphertext
   rows, safe). Rows are flagged for re-wrap only insofar as the
   remaining readership set changed.
3. **Re-wrap (client).** The acting admin device, holding the
   unwrapped master key, walks the affected `entity_deks` population
   and, for each DEK, ensures a fresh wrapped copy exists for every
   remaining authorized reader pubkey: unwrap the DEK via the admin's
   own copy (or via master key, per the wrap layer design), re-wrap
   (AES-256-GCM with fresh IV per copy) to each remaining member's
   device pubkey, upsert the `entity_deks` rows.
4. **Verify (client).** Re-unwrap one freshly written copy per
   remaining member before reporting success — a botched wrap written
   to the server would silently brick that reader.
5. **Audit (server).** Write an `admin_audit` entry: actor, tenant,
   `dek.rewrap` action, affected row count, reason
   (`member_revoked` / `device_revoked`).

### Why re-wrap at all

Step 1–2 already deny future access, but any DEK the revoked member
previously unwrapped remains in their memory/backups. Re-wrapping
without rotating the DEK does **not** revoke knowledge of that DEK —
it only repairs the keyring so remaining members keep working after
the wrap topology changes. True cryptographic revocation needs the
rotation ceremony below.

## Rotation ceremony (compromised member/device/master key)

When revocation is driven by suspected compromise, DEKs the member
could reach must be rotated, not just re-wrapped:

1. Run steps 1–2 above.
2. For each affected record, the client generates a **new** DEK,
   decrypts the ciphertext with the old DEK, re-encrypts with the new
   DEK (fresh IV), updates `content_hash`-signed metadata where the
   integrity chain requires it, and uploads the new ciphertext.
3. Wrap the new DEK to every remaining reader pubkey; upsert
   `entity_deks`.
4. Old ciphertext is overwritten — the old DEK becomes useless to the
   departed member.

Rotation is O(records × payload) and must run as a resumable
background job on the admin device (checkpoint per batch; the UI may
show "key rotation in progress"). Large tenants should rotate in
priority order: active patients first.

If the **master key** itself is suspected, wrap the _new_ master to
remaining member devices in `clinic_keys` first, then rotate DEKs
under it — same flow, one extra layer.

## Failure modes

- **No remaining key holder** → block revocation (see Preconditions).
- **Admin device offline mid-ceremony** → partial `entity_deks`
  updates are safe (each row is an independent wrap); re-run the
  ceremony — it is idempotent because step 3 upserts by
  (record, reader) pair.
- **Recovery phrase path** → re-importing the master key from the
  phrase mints a new member wrap entry; the ceremony then runs
  normally from that device.

## What the server MAY do

- Delete rows (`group_members`, `clinic_keys`, `entity_deks` copies).
- Enforce that only a clinic admin triggers revocation.
- Record the audit entry.
- Refuse auth to revoked member ids.

## What the server MUST NOT do

- Hold, derive, or accept any unwrapped key material.
- Perform re-wraps server-side (impossible by construction — keep it
  that way; do not add a "re-wrap" server fn that accepts keys).
