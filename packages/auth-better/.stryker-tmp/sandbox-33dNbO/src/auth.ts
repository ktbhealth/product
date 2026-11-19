// @ts-nocheck
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { betterAuth } from "better-auth";
import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { and, eq, ne } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import type { AccountsShape, ApiKeysShape, AuthShape, Session, SessionUser, UpdateUserResult } from "@ktb/auth";
import { account as accountTable, apikey as apikeyTable, session as sessionTable, user as userTable, verification as verificationTable } from "@ktb/db/schema";

/** What the host needs to compose and deliver a verification email. */
export interface VerificationEmailInput {
  readonly email: string;
  readonly name: string | null;
  /** Link that verifies the address when opened. */
  readonly url: string;
}

/** What the host needs to compose and deliver a password-reset email. */
export interface PasswordResetEmailInput {
  readonly email: string;
  readonly name: string | null;
  /** Link that validates the token and lands on the reset form. */
  readonly url: string;
}
export interface AuthOptions {
  readonly secret?: string;
  readonly baseURL?: string;
  /**
   * Delivers the verification link. When absent (no email sender
   * configured) nothing is sent on sign-up. Verification is never
   * required to sign in — flows that depend on a proven address check
   * `user.emailVerified` themselves.
   */
  readonly sendVerificationEmail?: (input: VerificationEmailInput) => Promise<void>;
  /**
   * Delivers the password-reset link. When absent the
   * /request-password-reset endpoint stays disabled — a deployment
   * without outbound email cannot recover accounts by mail anyway.
   */
  readonly sendPasswordResetEmail?: (input: PasswordResetEmailInput) => Promise<void>;
}
export type AuthDb = ReturnType<typeof drizzle>;
export const makeAuth = (db: AuthDb, opts: AuthOptions = {}) => {
  if (stryMutAct_9fa48("0")) {
    {}
  } else {
    stryCov_9fa48("0");
    const sendPasswordResetEmail = opts.sendPasswordResetEmail;
    return betterAuth(stryMutAct_9fa48("1") ? {} : (stryCov_9fa48("1"), {
      // Stryker disable next-line ObjectLiteral,StringLiteral: the drizzle adapter only special-cases "mysql"/"pg" — "", a missing provider, and "sqlite" are equivalent on every runtime path.
      database: drizzleAdapter(db, {
        provider: "sqlite"
      }),
      emailAndPassword: stryMutAct_9fa48("4") ? {} : (stryCov_9fa48("4"), {
        enabled: stryMutAct_9fa48("5") ? false : (stryCov_9fa48("5"), true),
        // A reset means the old password may be compromised — every
        // live session dies with it.
        revokeSessionsOnPasswordReset: stryMutAct_9fa48("6") ? false : (stryCov_9fa48("6"), true),
        // Only bound when the host can send email; an absent sender
        // leaves the endpoint answering RESET_PASSWORD_DISABLED
        // instead of silently dropping the message.
        ...((stryMutAct_9fa48("9") ? sendPasswordResetEmail !== undefined : stryMutAct_9fa48("8") ? false : stryMutAct_9fa48("7") ? true : (stryCov_9fa48("7", "8", "9"), sendPasswordResetEmail === undefined)) ? {} : stryMutAct_9fa48("10") ? {} : (stryCov_9fa48("10"), {
          sendResetPassword: async (data: {
            user: {
              email: string;
              name?: string | null;
            };
            url: string;
          }) => {
            if (stryMutAct_9fa48("11")) {
              {}
            } else {
              stryCov_9fa48("11");
              await sendPasswordResetEmail(stryMutAct_9fa48("12") ? {} : (stryCov_9fa48("12"), {
                email: data.user.email,
                name: stryMutAct_9fa48("13") ? data.user.name && null : (stryCov_9fa48("13"), data.user.name ?? null),
                url: data.url
              }));
            }
          }
        }))
      }),
      emailVerification: stryMutAct_9fa48("14") ? {} : (stryCov_9fa48("14"), {
        sendOnSignUp: stryMutAct_9fa48("17") ? opts.sendVerificationEmail === undefined : stryMutAct_9fa48("16") ? false : stryMutAct_9fa48("15") ? true : (stryCov_9fa48("15", "16", "17"), opts.sendVerificationEmail !== undefined),
        autoSignInAfterVerification: stryMutAct_9fa48("18") ? false : (stryCov_9fa48("18"), true),
        sendVerificationEmail: async ({
          user,
          url
        }) => {
          if (stryMutAct_9fa48("19")) {
            {}
          } else {
            stryCov_9fa48("19");
            await (stryMutAct_9fa48("20") ? opts.sendVerificationEmail({
              email: user.email,
              name: user.name ?? null,
              url
            }) : (stryCov_9fa48("20"), opts.sendVerificationEmail?.(stryMutAct_9fa48("21") ? {} : (stryCov_9fa48("21"), {
              email: user.email,
              name: stryMutAct_9fa48("22") ? user.name && null : (stryCov_9fa48("22"), user.name ?? null),
              url
            }))));
          }
        }
      }),
      secret: opts.secret,
      baseURL: opts.baseURL,
      plugins: stryMutAct_9fa48("23") ? [] : (stryCov_9fa48("23"), [
      // Managed credential store (eval lab outbound providers):
      // hashing disabled so `resolve` can read the secret back for
      // outbound calls, metadata enabled because the secret rides
      // inside `metadata` — keys live server-side, never on the wire.
      apiKey(stryMutAct_9fa48("24") ? {} : (stryCov_9fa48("24"), {
        disableKeyHashing: stryMutAct_9fa48("25") ? false : (stryCov_9fa48("25"), true),
        enableMetadata: stryMutAct_9fa48("26") ? false : (stryCov_9fa48("26"), true)
      }))])
    }));
  }
};
export type Auth = ReturnType<typeof makeAuth>;
export const toSessionUser = stryMutAct_9fa48("27") ? () => undefined : (stryCov_9fa48("27"), (() => {
  const toSessionUser = (u: {
    id: string;
    email: string;
    name?: string | null;
  }): SessionUser => stryMutAct_9fa48("28") ? {} : (stryCov_9fa48("28"), {
    id: u.id,
    email: u.email,
    name: stryMutAct_9fa48("29") ? u.name && null : (stryCov_9fa48("29"), u.name ?? null)
  });
  return toSessionUser;
})());
export const toSession = stryMutAct_9fa48("30") ? () => undefined : (stryCov_9fa48("30"), (() => {
  const toSession = (s: {
    user: {
      id: string;
      email: string;
      name?: string | null;
    };
    session: {
      id: string;
      expiresAt: Date;
    };
  }): Session => stryMutAct_9fa48("31") ? {} : (stryCov_9fa48("31"), {
    user: toSessionUser(s.user),
    sessionId: s.session.id,
    expiresAt: s.session.expiresAt
  });
  return toSession;
})());

/**
 * Auth port implementation over a better-auth instance + its drizzle
 * database (T-034). The `user.banned` flag is enforced here — not in
 * better-auth — so `getSession` returns null for suspended users and
 * `setUserBanned` revokes their session rows on ban.
 */
export const makeAuthService = stryMutAct_9fa48("32") ? () => undefined : (stryCov_9fa48("32"), (() => {
  const makeAuthService = (auth: Auth, db: AuthDb): AuthShape => stryMutAct_9fa48("33") ? {} : (stryCov_9fa48("33"), {
    getSession: async headers => {
      if (stryMutAct_9fa48("34")) {
        {}
      } else {
        stryCov_9fa48("34");
        const s = await auth.api.getSession(stryMutAct_9fa48("35") ? {} : (stryCov_9fa48("35"), {
          headers
        }));
        if (stryMutAct_9fa48("38") ? false : stryMutAct_9fa48("37") ? true : stryMutAct_9fa48("36") ? s : (stryCov_9fa48("36", "37", "38"), !s)) return null;
        const rows = await db.select(stryMutAct_9fa48("39") ? {} : (stryCov_9fa48("39"), {
          banned: userTable.banned
        })).from(userTable).where(eq(userTable.id, s.user.id)).limit(1);
        // A live session always resolves to a user row (FK cascade), so
        // `some` is equivalent to checking rows[0] without an
        // uncoverable optional-chain branch.
        if (stryMutAct_9fa48("42") ? rows.every(r => r.banned === true) : stryMutAct_9fa48("41") ? false : stryMutAct_9fa48("40") ? true : (stryCov_9fa48("40", "41", "42"), rows.some(stryMutAct_9fa48("43") ? () => undefined : (stryCov_9fa48("43"), r => stryMutAct_9fa48("46") ? r.banned !== true : stryMutAct_9fa48("45") ? false : stryMutAct_9fa48("44") ? true : (stryCov_9fa48("44", "45", "46"), r.banned === (stryMutAct_9fa48("47") ? false : (stryCov_9fa48("47"), true))))))) return null;
        return toSession(s);
      }
    },
    setUserBanned: async (userId, banned) => {
      if (stryMutAct_9fa48("48")) {
        {}
      } else {
        stryCov_9fa48("48");
        await db.update(userTable).set(stryMutAct_9fa48("49") ? {} : (stryCov_9fa48("49"), {
          banned
        })).where(eq(userTable.id, userId));
        if (stryMutAct_9fa48("51") ? false : stryMutAct_9fa48("50") ? true : (stryCov_9fa48("50", "51"), banned)) {
          if (stryMutAct_9fa48("52")) {
            {}
          } else {
            stryCov_9fa48("52");
            // Revoke every live session — getSession already returns null
            // for banned users, but deleting the rows also kills sessions
            // better-auth would otherwise keep refreshing.
            await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
          }
        }
      }
    },
    updateUser: async (userId, fields): Promise<UpdateUserResult> => {
      if (stryMutAct_9fa48("53")) {
        {}
      } else {
        stryCov_9fa48("53");
        const patch: {
          name?: string;
          email?: string;
          emailVerified?: boolean;
        } = {};
        // Stryker disable next-line ConditionalExpression: drizzle's update .set() skips undefined values, so assigning patch.name unconditionally is equivalent.
        if (stryMutAct_9fa48("56") ? fields.name === undefined : (stryCov_9fa48("56"), fields.name !== undefined)) patch.name = fields.name;
        if (stryMutAct_9fa48("59") ? fields.email === undefined : stryMutAct_9fa48("58") ? false : stryMutAct_9fa48("57") ? true : (stryCov_9fa48("57", "58", "59"), fields.email !== undefined)) {
          if (stryMutAct_9fa48("60")) {
            {}
          } else {
            stryCov_9fa48("60");
            const normalized = stryMutAct_9fa48("62") ? fields.email.toLowerCase() : stryMutAct_9fa48("61") ? fields.email.trim().toUpperCase() : (stryCov_9fa48("61", "62"), fields.email.trim().toLowerCase());
            // The `user.email` unique index would also catch this, but a
            // pre-check maps the conflict to "exists" instead of a raw
            // constraint error.
            const clash = await db.select(stryMutAct_9fa48("63") ? {} : (stryCov_9fa48("63"), {
              id: userTable.id
            })).from(userTable).where(and(eq(userTable.email, normalized), ne(userTable.id, userId))).limit(1);
            if (stryMutAct_9fa48("67") ? clash.length <= 0 : stryMutAct_9fa48("66") ? clash.length >= 0 : stryMutAct_9fa48("65") ? false : stryMutAct_9fa48("64") ? true : (stryCov_9fa48("64", "65", "66", "67"), clash.length > 0)) return stryMutAct_9fa48("68") ? {} : (stryCov_9fa48("68"), {
              ok: stryMutAct_9fa48("69") ? true : (stryCov_9fa48("69"), false),
              error: stryMutAct_9fa48("70") ? "" : (stryCov_9fa48("70"), "exists")
            });
            const current = await db.select(stryMutAct_9fa48("71") ? {} : (stryCov_9fa48("71"), {
              email: userTable.email
            })).from(userTable).where(eq(userTable.id, userId)).limit(1);
            // A new address was never verified — the flag belongs to the
            // old one and resets with the change. An unchanged email is
            // left alone so a name-only save keeps the flag.
            if (stryMutAct_9fa48("74") ? current[0] !== undefined || current[0].email !== normalized : stryMutAct_9fa48("73") ? false : stryMutAct_9fa48("72") ? true : (stryCov_9fa48("72", "73", "74"), (stryMutAct_9fa48("76") ? current[0] === undefined : stryMutAct_9fa48("75") ? true : (stryCov_9fa48("75", "76"), current[0] !== undefined)) && (stryMutAct_9fa48("78") ? current[0].email === normalized : stryMutAct_9fa48("77") ? true : (stryCov_9fa48("77", "78"), current[0].email !== normalized)))) {
              if (stryMutAct_9fa48("79")) {
                {}
              } else {
                stryCov_9fa48("79");
                patch.email = normalized;
                patch.emailVerified = stryMutAct_9fa48("80") ? true : (stryCov_9fa48("80"), false);
              }
            }
          }
        }
        if (stryMutAct_9fa48("83") ? patch.name === undefined || patch.email === undefined : stryMutAct_9fa48("82") ? false : stryMutAct_9fa48("81") ? true : (stryCov_9fa48("81", "82", "83"), (stryMutAct_9fa48("85") ? patch.name !== undefined : stryMutAct_9fa48("84") ? true : (stryCov_9fa48("84", "85"), patch.name === undefined)) && (stryMutAct_9fa48("87") ? patch.email !== undefined : stryMutAct_9fa48("86") ? true : (stryCov_9fa48("86", "87"), patch.email === undefined)))) return stryMutAct_9fa48("88") ? {} : (stryCov_9fa48("88"), {
          ok: stryMutAct_9fa48("89") ? false : (stryCov_9fa48("89"), true)
        });
        await db.update(userTable).set(patch).where(eq(userTable.id, userId));
        return stryMutAct_9fa48("90") ? {} : (stryCov_9fa48("90"), {
          ok: stryMutAct_9fa48("91") ? false : (stryCov_9fa48("91"), true)
        });
      }
    },
    deleteUser: async userId => {
      if (stryMutAct_9fa48("92")) {
        {}
      } else {
        stryCov_9fa48("92");
        const rows = await db.select(stryMutAct_9fa48("93") ? {} : (stryCov_9fa48("93"), {
          email: userTable.email
        })).from(userTable).where(eq(userTable.id, userId)).limit(1);
        const email = stryMutAct_9fa48("94") ? rows[0].email : (stryCov_9fa48("94"), rows[0]?.email);
        // Explicit deletes rather than relying on the FK cascades:
        // session/account declare onDelete cascade, but apikey and
        // verification have no user FK at all — apikey.referenceId is a
        // bare text column and verification.identifier holds the email.
        await db.delete(sessionTable).where(eq(sessionTable.userId, userId));
        await db.delete(accountTable).where(eq(accountTable.userId, userId));
        await db.delete(apikeyTable).where(eq(apikeyTable.referenceId, userId));
        // Stryker disable next-line ConditionalExpression: with no user row email is undefined and eq(identifier, undefined) matches no rows — running the delete is a no-op.
        if (stryMutAct_9fa48("97") ? email === undefined : (stryCov_9fa48("97"), email !== undefined)) {
          if (stryMutAct_9fa48("98")) {
            {}
          } else {
            stryCov_9fa48("98");
            await db.delete(verificationTable).where(eq(verificationTable.identifier, email));
          }
        }
        await db.delete(userTable).where(eq(userTable.id, userId));
      }
    }
  });
  return makeAuthService;
})());

/**
 * Accounts port implementation: the same steps as better-auth's
 * sign-up (normalized email, hashed password, credential account), but
 * the user starts with a verified email and no verification message is
 * sent. An address that already has an account is left untouched.
 */
export const makeAccountsService = stryMutAct_9fa48("99") ? () => undefined : (stryCov_9fa48("99"), (() => {
  const makeAccountsService = (auth: Auth): AccountsShape => stryMutAct_9fa48("100") ? {} : (stryCov_9fa48("100"), {
    createVerified: async ({
      email,
      name,
      password
    }) => {
      if (stryMutAct_9fa48("101")) {
        {}
      } else {
        stryCov_9fa48("101");
        const ctx = await auth.$context;
        const {
          minPasswordLength,
          maxPasswordLength
        } = ctx.password.config;
        if (stryMutAct_9fa48("104") ? password.length < minPasswordLength && password.length > maxPasswordLength : stryMutAct_9fa48("103") ? false : stryMutAct_9fa48("102") ? true : (stryCov_9fa48("102", "103", "104"), (stryMutAct_9fa48("107") ? password.length >= minPasswordLength : stryMutAct_9fa48("106") ? password.length <= minPasswordLength : stryMutAct_9fa48("105") ? false : (stryCov_9fa48("105", "106", "107"), password.length < minPasswordLength)) || (stryMutAct_9fa48("110") ? password.length <= maxPasswordLength : stryMutAct_9fa48("109") ? password.length >= maxPasswordLength : stryMutAct_9fa48("108") ? false : (stryCov_9fa48("108", "109", "110"), password.length > maxPasswordLength)))) {
          if (stryMutAct_9fa48("111")) {
            {}
          } else {
            stryCov_9fa48("111");
            return stryMutAct_9fa48("112") ? {} : (stryCov_9fa48("112"), {
              ok: stryMutAct_9fa48("113") ? true : (stryCov_9fa48("113"), false),
              error: stryMutAct_9fa48("114") ? "" : (stryCov_9fa48("114"), "invalid_password")
            });
          }
        }
        // Stryker disable next-line MethodExpression: internalAdapter.createUser lowercases email itself and findUserByEmail normalizes lookups, so the case fold here is redundant.
        const normalized = email.trim().toLowerCase();
        if (stryMutAct_9fa48("118") ? false : stryMutAct_9fa48("117") ? true : (stryCov_9fa48("117", "118"), await ctx.internalAdapter.findUserByEmail(normalized))) {
          if (stryMutAct_9fa48("119")) {
            {}
          } else {
            stryCov_9fa48("119");
            return stryMutAct_9fa48("120") ? {} : (stryCov_9fa48("120"), {
              ok: stryMutAct_9fa48("121") ? true : (stryCov_9fa48("121"), false),
              error: stryMutAct_9fa48("122") ? "" : (stryCov_9fa48("122"), "exists")
            });
          }
        }
        // Hashed before the user row exists, like sign-up: a failing hash
        // must not leave an account behind.
        const hash = await ctx.password.hash(password);
        const created = await ctx.internalAdapter.createUser(stryMutAct_9fa48("123") ? {} : (stryCov_9fa48("123"), {
          email: normalized,
          name,
          emailVerified: stryMutAct_9fa48("124") ? false : (stryCov_9fa48("124"), true)
        }),
        // Stryker disable next-line ObjectLiteral,StringLiteral: createUser's source argument is only read when user.validateUserInfo is configured, which this deployment never sets.
        {
          method: "email-password"
        });
        await ctx.internalAdapter.linkAccount(stryMutAct_9fa48("127") ? {} : (stryCov_9fa48("127"), {
          userId: created.id,
          providerId: stryMutAct_9fa48("128") ? "" : (stryCov_9fa48("128"), "credential"),
          accountId: created.id,
          password: hash
        }));
        return stryMutAct_9fa48("129") ? {} : (stryCov_9fa48("129"), {
          ok: stryMutAct_9fa48("130") ? false : (stryCov_9fa48("130"), true),
          userId: created.id
        });
      }
    }
  });
  return makeAccountsService;
})());

/**
 * `list` projection: metadata goes out with `secret` removed — the
 * raw column still holds it for `getSecret`/outbound reads, but a
 * listed row must never carry the plaintext. Unparseable or
 * non-object metadata collapses to `"{}"` rather than passing
 * through unchecked.
 */
const stripMetadataSecret = (raw: string | null): string | null => {
  if (stryMutAct_9fa48("131")) {
    {}
  } else {
    stryCov_9fa48("131");
    if (stryMutAct_9fa48("134") ? raw !== null : stryMutAct_9fa48("133") ? false : stryMutAct_9fa48("132") ? true : (stryCov_9fa48("132", "133", "134"), raw === null)) return null;
    try {
      if (stryMutAct_9fa48("135")) {
        {}
      } else {
        stryCov_9fa48("135");
        const parsed: unknown = JSON.parse(raw);
        // Stryker disable next-line ConditionalExpression: the `parsed === null` arm is redundant — destructuring null throws into the same catch that returns "{}".
        if (stryMutAct_9fa48("138") ? (typeof parsed !== "object" || parsed === null) && Array.isArray(parsed) : (stryCov_9fa48("138"), (stryMutAct_9fa48("140") ? typeof parsed !== "object" && parsed === null : (stryCov_9fa48("140"), (stryMutAct_9fa48("142") ? typeof parsed === "object" : (stryCov_9fa48("142"), typeof parsed !== (stryMutAct_9fa48("143") ? "" : (stryCov_9fa48("143"), "object")))) || (stryMutAct_9fa48("145") ? parsed !== null : (stryCov_9fa48("145"), parsed === null)))) || Array.isArray(parsed))) return stryMutAct_9fa48("146") ? "" : (stryCov_9fa48("146"), "{}");
        const {
          secret: _secret,
          ...rest
        } = parsed as Record<string, unknown>;
        return JSON.stringify(rest);
      }
    } catch {
      if (stryMutAct_9fa48("147")) {
        {}
      } else {
        stryCov_9fa48("147");
        return stryMutAct_9fa48("148") ? "" : (stryCov_9fa48("148"), "{}");
      }
    }
  }
};

/**
 * apiKey-plugin adapter for eval-lab outbound credentials. The plugin
 * OWNS create/delete semantics (its `apikey` table is the store); raw
 * secrets ride inside `metadata.secret` — `disableKeyHashing` keeps
 * the row readable server-side for outbound calls while `list`/the
 * wire only ever see masked metadata. `list`/`getSecret` read the
 * table directly because the plugin's read endpoints are
 * session-header-scoped (a service has no headers); writes go
 * through `auth.api` so plugin hooks and bookkeeping stay canonical.
 *
 * Secrets at rest are plaintext-in-metadata BY DESIGN for the eval
 * lab's outbound calls; this adapter is the boundary that keeps them
 * off list/read paths. If these keys ever serve production tenants,
 * migrate secret storage to @ktb/crypto EntityCipher.
 */
export const makeApiKeysAdapter = stryMutAct_9fa48("149") ? () => undefined : (stryCov_9fa48("149"), (() => {
  const makeApiKeysAdapter = (auth: Auth, db: AuthDb): ApiKeysShape => stryMutAct_9fa48("150") ? {} : (stryCov_9fa48("150"), {
    create: async (input: {
      readonly name: string;
      readonly referenceId: string;
      readonly metadata: Record<string, unknown>;
    }) => {
      if (stryMutAct_9fa48("151")) {
        {}
      } else {
        stryCov_9fa48("151");
        // `secret` stays for getSecret/outbound reads; `secretLast4` is
        // the only hint `list` may show. The >4 guard keeps a short
        // secret from being revealed whole by its own "last 4".
        const secret = input.metadata.secret;
        const metadata = (stryMutAct_9fa48("154") ? typeof secret === "string" || secret.length > 4 : stryMutAct_9fa48("153") ? false : stryMutAct_9fa48("152") ? true : (stryCov_9fa48("152", "153", "154"), (stryMutAct_9fa48("156") ? typeof secret !== "string" : stryMutAct_9fa48("155") ? true : (stryCov_9fa48("155", "156"), typeof secret === (stryMutAct_9fa48("157") ? "" : (stryCov_9fa48("157"), "string")))) && (stryMutAct_9fa48("160") ? secret.length <= 4 : stryMutAct_9fa48("159") ? secret.length >= 4 : stryMutAct_9fa48("158") ? true : (stryCov_9fa48("158", "159", "160"), secret.length > 4)))) ? stryMutAct_9fa48("161") ? {} : (stryCov_9fa48("161"), {
          ...input.metadata,
          secretLast4: stryMutAct_9fa48("162") ? secret : (stryCov_9fa48("162"), secret.slice(stryMutAct_9fa48("163") ? +4 : (stryCov_9fa48("163"), -4)))
        }) : input.metadata;
        const r = await auth.api.createApiKey(stryMutAct_9fa48("164") ? {} : (stryCov_9fa48("164"), {
          body: stryMutAct_9fa48("165") ? {} : (stryCov_9fa48("165"), {
            name: input.name,
            userId: input.referenceId,
            metadata,
            rateLimitEnabled: stryMutAct_9fa48("166") ? true : (stryCov_9fa48("166"), false)
          })
        }));
        return stryMutAct_9fa48("167") ? {} : (stryCov_9fa48("167"), {
          id: r.id
        });
      }
    },
    list: async (referenceId: string) => {
      if (stryMutAct_9fa48("168")) {
        {}
      } else {
        stryCov_9fa48("168");
        const rows = await db.select().from(apikeyTable).where(eq(apikeyTable.referenceId, referenceId));
        return rows.map(stryMutAct_9fa48("169") ? () => undefined : (stryCov_9fa48("169"), row => stryMutAct_9fa48("170") ? {} : (stryCov_9fa48("170"), {
          ...row,
          metadata: stripMetadataSecret(row.metadata)
        })));
      }
    },
    remove: async (keyId: string, referenceId: string) => {
      if (stryMutAct_9fa48("171")) {
        {}
      } else {
        stryCov_9fa48("171");
        // Ownership check first — acting on `keyId` alone would let one
        // user delete another's credential by guessing the id.
        const owned = await db.select(stryMutAct_9fa48("172") ? {} : (stryCov_9fa48("172"), {
          id: apikeyTable.id
        })).from(apikeyTable).where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId))).limit(1);
        if (stryMutAct_9fa48("175") ? owned.length !== 0 : stryMutAct_9fa48("174") ? false : stryMutAct_9fa48("173") ? true : (stryCov_9fa48("173", "174", "175"), owned.length === 0)) return;
        try {
          if (stryMutAct_9fa48("176")) {
            {}
          } else {
            stryCov_9fa48("176");
            await auth.api.deleteApiKey(stryMutAct_9fa48("177") ? {} : (stryCov_9fa48("177"), {
              body: stryMutAct_9fa48("178") ? {} : (stryCov_9fa48("178"), {
                keyId
              })
            }));
          }
        } catch {
          if (stryMutAct_9fa48("179")) {
            {}
          } else {
            stryCov_9fa48("179");
            await db.delete(apikeyTable).where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId)));
          }
        }
      }
    },
    getSecret: async (keyId: string, referenceId: string): Promise<string | null> => {
      if (stryMutAct_9fa48("180")) {
        {}
      } else {
        stryCov_9fa48("180");
        const rows = await db.select(stryMutAct_9fa48("181") ? {} : (stryCov_9fa48("181"), {
          metadata: apikeyTable.metadata
        })).from(apikeyTable).where(and(eq(apikeyTable.id, keyId), eq(apikeyTable.referenceId, referenceId)));
        const raw = stryMutAct_9fa48("182") ? rows[0].metadata : (stryCov_9fa48("182"), rows[0]?.metadata);
        // Stryker disable next-line ConditionalExpression,LogicalOperator: raw is string|null|undefined; null/undefined falling through to JSON.parse still yields null (parse("null")→null.secret throws, parse(undefined) throws) — both paths return null.
        if ((stryMutAct_9fa48("187") ? raw !== null : (stryCov_9fa48("187"), raw === null)) || (stryMutAct_9fa48("189") ? raw !== undefined : (stryCov_9fa48("189"), raw === undefined))) return null;
        try {
          if (stryMutAct_9fa48("190")) {
            {}
          } else {
            stryCov_9fa48("190");
            const parsed = JSON.parse(raw) as {
              secret?: unknown;
            };
            return (stryMutAct_9fa48("193") ? typeof parsed.secret !== "string" : stryMutAct_9fa48("192") ? false : stryMutAct_9fa48("191") ? true : (stryCov_9fa48("191", "192", "193"), typeof parsed.secret === (stryMutAct_9fa48("194") ? "" : (stryCov_9fa48("194"), "string")))) ? parsed.secret : null;
          }
        } catch {
          if (stryMutAct_9fa48("195")) {
            {}
          } else {
            stryCov_9fa48("195");
            return null;
          }
        }
      }
    }
  });
  return makeApiKeysAdapter;
})());