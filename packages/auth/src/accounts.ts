import * as Context from "effect/Context";

/** Why an account could not be created. */
export type AccountRejection = "exists" | "invalid_password";

export type CreateAccountResult =
	| { readonly ok: true; readonly userId: string }
	| { readonly ok: false; readonly error: AccountRejection };

/** Shape of the Accounts port — exported so adapters can type their
 * factory without re-declaring the contract. */
export interface AccountsShape {
	/**
	 * Create a credential account whose email is already proven — the
	 * caller holds evidence the person controls the address (an invite
	 * token delivered to it), so the account starts verified and no
	 * verification email is sent. Creates nothing and reports "exists"
	 * when the address already has an account: it never touches an
	 * existing one. Never signs anyone in.
	 */
	createVerified(input: {
		readonly email: string;
		readonly name: string;
		readonly password: string;
	}): Promise<CreateAccountResult>;
}

/** Account provisioning port. Impl lives in @ktb/auth-better. */
export class Accounts extends Context.Service<Accounts, AccountsShape>()("@ktb/auth/Accounts") {}
