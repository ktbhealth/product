import { beforeEach, describe, expect, it, vi } from "vitest";

import * as Effect from "effect/Effect";

import { EMAIL_OUTBOX_KIND, Email, type EmailSender } from "@ktb/email";
import { Outbox } from "@ktb/outbox";

const mocks = vi.hoisted(() => ({ run: vi.fn() }));

// Same fake as the plugin fns tests: the handler runs as a plain async fn.
vi.mock("@tanstack/react-start/server", () => ({
	getRequestUrl: () => new URL("https://app.ktb.test/secretaries"),
}));
vi.mock("@ktb/server-fns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ktb/server-fns")>();
	return { ...actual, run: mocks.run };
});

import { Invites, sendInviteEmail } from "./index.ts";

const delivering: EmailSender = { send: vi.fn(async () => {}) };
const sent = () => (delivering.send as ReturnType<typeof vi.fn>).mock.calls.map(([m]) => m);

/** The deployment's Email service: a sender, null when disabled, or
 * absent when the capability is not bound at all. */
let sender: EmailSender | null | "absent" = delivering;
/** The outbox service's enqueue spy; null = service unbound (legacy
 * inline-send fallback). */
let enqueue: ReturnType<typeof vi.fn> | null = null;
/** The invites plugin's `issue`, or null when it is not deployed. */
let issue: ReturnType<typeof vi.fn> | null = null;

const provide = (effect: Effect.Effect<unknown, unknown, unknown>) => {
	let provided = effect as Effect.Effect<unknown, unknown, never>;
	if (sender !== "absent") {
		provided = provided.pipe(Effect.provideService(Email, sender));
	}
	if (enqueue !== null) {
		provided = provided.pipe(Effect.provideService(Outbox, { enqueue, drain: vi.fn() } as never));
	}
	if (issue !== null) {
		provided = provided.pipe(
			Effect.provideService(Invites, {
				issue,
				preview: vi.fn(),
				accept: vi.fn(),
			} as never),
		);
	}
	return Effect.runPromise(provided);
};

const invite = {
	to: "sec@ktb.test",
	kind: "secretary" as const,
	inviterName: "Dra. Ana",
	subject: "Dra. Ana invited you",
	body: (url: string, accept: boolean) => `open ${url} accept=${accept}`,
};

beforeEach(() => {
	vi.clearAllMocks();
	sender = delivering;
	enqueue = null;
	issue = null;
	mocks.run.mockImplementation((effect: Effect.Effect<unknown, unknown, unknown>) =>
		provide(effect),
	);
});

describe("sendInviteEmail", () => {
	it("sends inline with the kind's sign-in page when no accept link issues", async () => {
		await expect(sendInviteEmail(invite)).resolves.toBe(true);
		expect(sent()).toEqual([
			{
				to: "sec@ktb.test",
				subject: "Dra. Ana invited you",
				text: "open https://app.ktb.test/login/secretary accept=false",
			},
		]);
	});

	it("links a single-use accept path when the invites plugin issues one", async () => {
		issue = vi.fn(() => Effect.succeed("tok-123"));
		await expect(sendInviteEmail(invite)).resolves.toBe(true);
		expect(issue).toHaveBeenCalledWith({
			email: "sec@ktb.test",
			kind: "secretary",
			inviterName: "Dra. Ana",
		});
		expect(sent()[0]).toMatchObject({
			text: "open https://app.ktb.test/invite#tok-123 accept=true",
		});
	});

	it("queues on the outbox instead of sending inline when bound", async () => {
		enqueue = vi.fn().mockResolvedValue({ id: "ob1" });
		await expect(sendInviteEmail(invite)).resolves.toBe(true);
		expect(sent()).toHaveLength(0);
		expect(enqueue).toHaveBeenCalledWith({
			kind: EMAIL_OUTBOX_KIND,
			payload: expect.objectContaining({ to: "sec@ktb.test" }),
		});
	});

	it.each(["disabled", "absent"] as const)(
		"reports false and issues no link when email is %s",
		async (mode) => {
			sender = mode === "disabled" ? null : "absent";
			issue = vi.fn(() => Effect.succeed("tok-123"));
			await expect(sendInviteEmail(invite)).resolves.toBe(false);
			expect(issue).not.toHaveBeenCalled();
			expect(sent()).toHaveLength(0);
		},
	);

	it("reports false under the caller's error label when delivery fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		sender = {
			send: vi.fn(async () => {
				throw new Error("smtp down");
			}),
		};
		await expect(
			sendInviteEmail({ ...invite, errorLabel: "secretary invite email failed" }),
		).resolves.toBe(false);
		expect(logged).toHaveBeenCalledWith("secretary invite email failed", expect.any(Error));
		logged.mockRestore();
	});

	it("reports false when the outbox write fails", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		enqueue = vi.fn().mockRejectedValue(new Error("db down"));
		await expect(sendInviteEmail(invite)).resolves.toBe(false);
		expect(logged).toHaveBeenCalledWith("invite email failed", expect.any(Error));
		logged.mockRestore();
	});
});
