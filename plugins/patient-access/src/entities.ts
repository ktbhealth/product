/**
 * `entity_deks` namespace discriminators (PL-007 F3, T-136): the
 * entity_type string is ZK key material — the DEK wrapped for a record
 * is stored under it, so two plugins naming the same record differently
 * silently breaks grants.
 *
 * Canonical home is this plugin, not `@ktb/consultations`: consultations
 * already depends on patient-access (apis.ts), so patient-access cannot
 * import the cipher spec back without a package-graph cycle. The literal
 * must never drift — changing it orphans every entity_deks row and grant
 * written under the old name.
 */
export const CONSULTATION_ENTITY_TYPE = "consultation";
