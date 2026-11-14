import type { InviteKind } from "./schema.ts";

/**
 * Where each kind of invitee goes: `home` once their account exists and
 * they are signed in, `login` when the address already has an account.
 * Owned by other plugins — coupled by URL only.
 */
export const INVITE_DESTINATIONS: Record<
	InviteKind,
	{ readonly home: string; readonly login: string }
> = {
	secretary: { home: "/", login: "/secretaries/login" },
	patient: { home: "/portal", login: "/portal/login" },
};
