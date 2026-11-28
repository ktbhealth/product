import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	reactStartMock,
	reactStartServerMock,
	serverFnRequestHeaders,
} from "@ktb/server-fns/testing";

import { env } from "cloudflare:workers";

vi.mock("@tanstack/react-start/server", () => ({
	...reactStartServerMock(),
	getRequestUrl: () => new URL("http://localhost:3000/secretaries"),
}));
vi.mock("@tanstack/react-start", () => reactStartMock());

// The Email driver is selected once, when platform.ts composes the app:
// bind the stub first so invite emails are "sent" (logged) and the test
// can read the link exactly as an invitee would receive it.
env.EMAIL_STUB = "1";

const { and, eq } = await import("drizzle-orm");
const { doctorAccess, inviteTokens, patientAccess, user } = await import("@ktb/db/schema");
const { acceptInviteFn, invitePreviewFn } = await import("@ktb/invites/fns");
const { invitePatientFn } = await import("@ktb/patient-access/fns");
const { createPatientFn, listPatientsFn } = await import("@ktb/patients/fns");
const { inviteSecretaryFn } = await import("@ktb/secretaries/fns");
const { signUpDoctor } = await import("#/test/doctor.ts");
const { auth, db } = await import("./platform.ts");
const { portalPageDataFn } = await import("./fns.ts");

// End to end: a doctor invites someone who has no account; the invitee
// opens the emailed link, chooses a password, and is in — verified and
// with the invited access active. The link creates accounts only: it
// never opens, verifies or changes one that already exists.

const PASSWORD = "senha-forte-123";

async function signIn(email: string, password = PASSWORD) {
	const res = await auth.handler(
		new Request("http://localhost:3000/api/auth/sign-in/email", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ email, password }),
		}),
	);
	return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0]! };
}

const as = (cookie: string | null) => {
	serverFnRequestHeaders.current = cookie === null ? new Headers() : new Headers({ cookie });
};

const account = async (email: string) => {
	const [row] = await db.select().from(user).where(eq(user.email, email));
	return row;
};

describe("invite links, end to end", () => {
	const mail = vi.spyOn(console, "info").mockImplementation(() => {});
	let doctor = "";
	let patientId = 0;

	/** The body of the last email "sent" to `to`. Invite mail rides the
	 * outbox: enqueue kicks a best-effort drain, so delivery lands a
	 * tick after the server fn returns — poll until the stub logs it. */
	const lastEmailTo = async (to: string, includes?: string): Promise<string> => {
		let found: string | undefined;
		await vi.waitFor(() => {
			found = mail.mock.calls
				.map((call) => String(call[0]))
				.filter((line) => line.startsWith(`[email-stub] to=${to} `))
				.filter((line) => includes === undefined || line.includes(includes))
				.pop();
			expect(found).toBeDefined();
		});
		return found!;
	};
	/** The accept-link token in an email — null when it links elsewhere. */
	const tokenIn = (email: string): string | null =>
		/^http:\/\/localhost:3000\/invite#([\w-]+)$/m.exec(email)?.[1] ?? null;

	beforeAll(async () => {
		await signUpDoctor({ email: "invite-doctor@x.com", password: PASSWORD, name: "Dra Convite" });
		doctor = (await signIn("invite-doctor@x.com")).cookie;
		as(doctor);
		const created = await createPatientFn({
			data: { name: "Paciente Convidado", birthDate: "1984-03-05" },
		});
		if (!created.ok) throw new Error("patient not created");
		patientId = created.patient.id;
	});

	beforeEach(() => {
		mail.mockClear();
		as(doctor);
	});

	it("a new secretary accepts the emailed link, signs in and works for the doctor", async () => {
		const invited = await inviteSecretaryFn({ data: { email: "nova-sec@x.com" } });
		expect(invited).toMatchObject({ ok: true, secretary: { status: "invited" } });
		const email = await lastEmailTo("nova-sec@x.com");
		const token = tokenIn(email)!;
		expect(token).toMatch(/^[\w-]{43}$/);
		expect(email).not.toContain("/login/secretary");
		// Only the hash is stored: the token itself is nowhere in the table.
		const stored = await db.select().from(inviteTokens);
		expect(JSON.stringify(stored)).not.toContain(token);

		// The invitee is not signed in when they open the link.
		as(null);
		expect(await invitePreviewFn({ data: token })).toEqual({
			email: "nova-sec@x.com",
			kind: "secretary",
			inviterName: "Dra Convite",
			accountExists: false,
		});
		expect(
			await acceptInviteFn({ data: { token, name: " Nova Secretária ", password: PASSWORD } }),
		).toEqual({ ok: true, email: "nova-sec@x.com", kind: "secretary" });

		// Verified without a verification email, and the delegation is active.
		const created = await account("nova-sec@x.com");
		expect(created).toMatchObject({ name: "Nova Secretária", emailVerified: true });
		const [delegation] = await db
			.select()
			.from(doctorAccess)
			.where(eq(doctorAccess.email, "nova-sec@x.com"));
		expect(delegation).toMatchObject({ status: "active", userId: created!.id });

		// Accepting does not sign in; the chosen password does — and the
		// secretary then sees the doctor's patients.
		const session = await signIn("nova-sec@x.com");
		expect(session.status).toBe(200);
		as(session.cookie);
		expect((await listPatientsFn()).map((p) => p.name)).toEqual(["Paciente Convidado"]);

		// The link is single-use.
		as(null);
		expect(await invitePreviewFn({ data: token })).toBeNull();
		expect(await acceptInviteFn({ data: { token, name: "Outra", password: PASSWORD } })).toEqual({
			ok: false,
			error: "invalid",
		});
	});

	it("a new patient accepts the emailed link and sees their record in the portal", async () => {
		const invited = await invitePatientFn({
			data: { patientId, email: "novo-paciente@x.com", relation: "self" },
		});
		expect(invited).toMatchObject({ ok: true, emailed: true, link: { status: "invited" } });
		const email = await lastEmailTo("novo-paciente@x.com");
		const token = tokenIn(email)!;
		expect(email).not.toContain("/login/patient");

		as(null);
		expect(await invitePreviewFn({ data: token })).toMatchObject({
			kind: "patient",
			accountExists: false,
		});
		expect(
			await acceptInviteFn({ data: { token, name: "Novo Paciente", password: PASSWORD } }),
		).toEqual({ ok: true, email: "novo-paciente@x.com", kind: "patient" });
		const created = await account("novo-paciente@x.com");
		const [link] = await db
			.select()
			.from(patientAccess)
			.where(eq(patientAccess.email, "novo-paciente@x.com"));
		expect(link).toMatchObject({ status: "active", userId: created!.id });

		as((await signIn("novo-paciente@x.com")).cookie);
		const res = await portalPageDataFn({ data: "/portal/patient" });
		const portal = res.status === "ok" ? (res.data as { profiles: unknown[] }) : null;
		expect(portal?.profiles).toEqual([{ patientId, name: "Paciente Convidado", relation: "self" }]);
		// A patient account has no doctor side.
		expect(await listPatientsFn()).toEqual([]);
	});

	it("an address that already has an account gets the sign-in link and no token", async () => {
		await auth.api.signUpEmail({
			body: { email: "ja-tem-conta@x.com", password: PASSWORD, name: "Já Tem" },
		});
		await inviteSecretaryFn({ data: { email: "ja-tem-conta@x.com" } });
		// signUpEmail queued a verification mail to the same address —
		// wait for the invite's sign-in link specifically.
		const email = await lastEmailTo("ja-tem-conta@x.com", "/login/secretary");
		expect(tokenIn(email)).toBeNull();
		expect(email).toContain("http://localhost:3000/login/secretary");
		expect(
			await db.select().from(inviteTokens).where(eq(inviteTokens.email, "ja-tem-conta@x.com")),
		).toEqual([]);
	});

	it("a link never opens or verifies an account registered before it was used", async () => {
		await inviteSecretaryFn({ data: { email: "vitima@x.com" } });
		const token = tokenIn(await lastEmailTo("vitima@x.com"))!;
		// Someone else registers the invited address — unverified, since
		// they cannot read its mail — hoping the invite lands on them.
		await auth.api.signUpEmail({
			body: { email: "vitima@x.com", password: "senha-do-intruso-1", name: "Intruso" },
		});

		as(null);
		expect(await invitePreviewFn({ data: token })).toMatchObject({ accountExists: true });
		expect(await acceptInviteFn({ data: { token, name: "Vítima", password: PASSWORD } })).toEqual({
			ok: false,
			error: "account_exists",
		});

		// Nothing changed: not verified, not renamed, password not replaced,
		// and the delegation is still waiting for a verified address.
		expect(await account("vitima@x.com")).toMatchObject({ name: "Intruso", emailVerified: false });
		expect((await signIn("vitima@x.com")).status).not.toBe(200);
		expect((await signIn("vitima@x.com", "senha-do-intruso-1")).status).toBe(200);
		const [delegation] = await db
			.select()
			.from(doctorAccess)
			.where(eq(doctorAccess.email, "vitima@x.com"));
		expect(delegation).toMatchObject({ status: "invited", userId: null });
	});

	it("re-inviting replaces the link, and a refused password leaves it usable", async () => {
		await inviteSecretaryFn({ data: { email: "reconvite@x.com" } });
		const first = tokenIn(await lastEmailTo("reconvite@x.com"))!;
		mail.mockClear();
		await inviteSecretaryFn({ data: { email: "reconvite@x.com" } });
		const second = tokenIn(await lastEmailTo("reconvite@x.com"))!;
		expect(second).not.toBe(first);

		as(null);
		expect(await invitePreviewFn({ data: first })).toBeNull();
		expect(
			await acceptInviteFn({ data: { token: second, name: "Reconvite", password: "curta" } }),
		).toEqual({ ok: false, error: "invalid_password" });
		expect(await account("reconvite@x.com")).toBeUndefined();
		expect(await invitePreviewFn({ data: second })).toMatchObject({ accountExists: false });
	});

	it("an expired link creates nothing", async () => {
		await inviteSecretaryFn({ data: { email: "expirado@x.com" } });
		const token = tokenIn(await lastEmailTo("expirado@x.com"))!;
		await db
			.update(inviteTokens)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(and(eq(inviteTokens.email, "expirado@x.com"), eq(inviteTokens.kind, "secretary")));

		as(null);
		expect(await invitePreviewFn({ data: token })).toBeNull();
		expect(await acceptInviteFn({ data: { token, name: "Expirado", password: PASSWORD } })).toEqual(
			{ ok: false, error: "invalid" },
		);
		expect(await account("expirado@x.com")).toBeUndefined();
	});
});
