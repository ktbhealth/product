import * as Context from "effect/Context";

/** Authenticated principal — what every plugin sees, provider-agnostic. */
export interface SessionUser {
	readonly id: string;
	readonly email: string;
	readonly name: string | null;
}

export interface Session {
	readonly user: SessionUser;
	readonly sessionId: string;
	readonly expiresAt: Date;
}

/** Shape of the Auth port — exported so adapter implementations can
 * type their factory without re-declaring the contract. */
export interface AuthShape {
	getSession(headers: Headers): Promise<Session | null>;
	/**
	 * Platform suspension switch (T-034): `true` bans the user —
	 * `getSession` must return null for them and their existing
	 * sessions are revoked; `false` reactivates. Provider-agnostic:
	 * adapters map it onto their own user/session storage.
	 */
	setUserBanned(userId: string, banned: boolean): Promise<void>;
}

/** Auth port: request → session. Impl lives in @ktb/auth-better. */
export class Auth extends Context.Service<Auth, AuthShape>()("@ktb/auth/Auth") {}

/** Shape of the managed API-key store (better-auth apiKey plugin
 * adapter): outbound credentials for eval providers. `metadata`
 * carries `{provider, secret}`; rows are per-user (`referenceId`). */
export interface ApiKeysShape {
	create(input: {
		readonly name: string;
		readonly referenceId: string;
		readonly metadata: Record<string, unknown>;
	}): Promise<{ readonly id: string }>;
	list(referenceId: string): Promise<readonly ApiKeyRow[]>;
	/**
	 * Owner-scoped delete: the row must belong to `referenceId` —
	 * another user's key id is a silent no-op (IDOR guard).
	 */
	remove(keyId: string, referenceId: string): Promise<void>;
	/**
	 * Owner-scoped read-back: returns the secret only when the row
	 * belongs to `referenceId`, null otherwise.
	 */
	getSecret(keyId: string, referenceId: string): Promise<string | null>;
}

export interface ApiKeyRow {
	readonly id: string;
	readonly referenceId: string;
	readonly name: string | null;
	readonly start: string | null;
	readonly enabled: boolean | null;
	readonly metadata: string | null;
}

/** Managed API-key store port — impl lives in @ktb/auth-better over
 * the apiKey plugin's `apikey` table. */
export class ApiKeys extends Context.Service<ApiKeys, ApiKeysShape>()("@ktb/auth/ApiKeys") {}

export {
	Accounts,
	type AccountRejection,
	type AccountsShape,
	type CreateAccountResult,
} from "./accounts.ts";
export {
	actingAs,
	DOCTOR_PROFILE_COOKIE,
	DoctorDelegations,
	DoctorProfiles,
	PATIENT_PROFILE_COOKIE,
	PatientProfiles,
	profileIdFromHeaders,
	resolveDoctorProfile,
	resolvePatientProfile,
	type ActingUser,
	type DoctorProfile,
	type PatientProfile,
} from "./profiles.ts";
