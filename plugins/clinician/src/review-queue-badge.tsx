// Client-manifest bridge (client-contract): src/client.ts may only
// value-import relative .tsx modules, so the consultations-owned
// sidebar badge is re-exported through this shim — same module
// identity as the server manifest's package import keeps the
// client/server parity assertion intact.
export { ReviewQueueBadge } from "@ktb/consultations/review-queue-badge";
