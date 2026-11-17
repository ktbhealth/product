/**
 * `entity_deks` namespace discriminators shared across plugins (PL-007
 * F3, T-136): the entity_type string is ZK key material — the DEK
 * wrapped for a record is stored under it, so two plugins naming the
 * same record differently silently breaks grants. The canonical value
 * lives here, in the lowest-level package both consumers already
 * depend on, because the natural owners cannot see each other:
 * @ktb/consultations depends on @ktb/patient-access (apis.ts), so
 * patient-access cannot import the cipher spec back.
 *
 * Cipher specs reference these (`entity:`) so `cipher.entity` stays
 * the public alias — consumers should keep reading it where they
 * already do.
 */
export const CONSULTATION_ENTITY_TYPE = "consultation";
