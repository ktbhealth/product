// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	doctorAccessFn: vi.fn(),
	patientLinksFn: vi.fn(),
	invitePatientFn: vi.fn(
		async (_arg: { data: { patientId: number; email: string; relation: string } }) => ({
			ok: true,
		}),
	),
	approvePatientLinkFn: vi.fn(async (_arg: { data: number }) => ({ ok: true })),
	revokePatientLinkFn: vi.fn(async (_arg: { data: number }) => ({ ok: false })),
	portalReadersFn: vi.fn(
		async (): Promise<{
			readonly readers: readonly { readerId: string; wrapPublicKey: string }[];
			readonly cipheredConsultationIds: readonly number[];
		} | null> => ({ readers: [], cipheredConsultationIds: [] }),
	),
	localeFn: vi.fn(async () => "pt-BR"),
	vaultStateFn: vi.fn(async () => ({ zk: false })),
	vaultDekEnvelopesFn: vi.fn(
		async (_call: {
			data: {
				entityType: string;
				entityIds: readonly (number | string)[];
				wrapPublicKey: string;
			};
		}): Promise<Record<string, string>> => ({}),
	),
	vaultGrantAccessFn: vi.fn(async () => ({ ok: true })),
	invalidate: vi.fn(),
	loaderData: { current: undefined as unknown },
	props: { current: undefined as Record<string, unknown> | undefined },
}));

vi.mock("./fns.ts", () => ({
	doctorAccessFn: mocks.doctorAccessFn,
	patientLinksFn: mocks.patientLinksFn,
	invitePatientFn: mocks.invitePatientFn,
	approvePatientLinkFn: mocks.approvePatientLinkFn,
	revokePatientLinkFn: mocks.revokePatientLinkFn,
	portalReadersFn: mocks.portalReadersFn,
	localeFn: mocks.localeFn,
}));
vi.mock("@ktb/vault/fns", () => ({
	vaultStateFn: mocks.vaultStateFn,
	vaultDekEnvelopesFn: mocks.vaultDekEnvelopesFn,
	vaultGrantAccessFn: mocks.vaultGrantAccessFn,
}));
vi.mock("./views/index.ts", () => ({
	PatientAccessPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div", { "data-testid": "patient-access" });
	},
}));
// Server fns become plain async calls; with no runtime registered the
// plugin route gate (createPluginFileRoute → pluginEnabledFn) is inert.
vi.mock("@tanstack/react-start", () => ({
	createServerFn: () => {
		let validate: ((value: unknown) => unknown) | undefined;
		const api = {
			validator: (fn: (value: unknown) => unknown) => {
				validate = fn;
				return api;
			},
			handler: (h: (arg: { data: unknown }) => unknown) => async (call: { data?: unknown }) =>
				h({
					data: validate === undefined ? call?.data : validate(call?.data),
				}),
		};
		return api;
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		getRouteApi: () => ({ useLoaderData: () => ({ i18n: undefined }) }),
		useRouter: () => ({ invalidate: mocks.invalidate }),
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
		}),
	};
});

import { isNotFound, isRedirect } from "@tanstack/react-router";
import { encrypt, generateDek } from "@ktb/crypto/aead";
import { makeKeyring, memoryStore } from "@ktb/crypto/keyring";

import { Route } from "./routes/$patientId.tsx";

const options = (
	Route as unknown as {
		options: {
			beforeLoad: () => Promise<void>;
			loader: (args: { params: { patientId: string } }) => Promise<unknown>;
			component: () => ReactElement;
		};
	}
).options;

const redirectTarget = async (run: () => Promise<unknown>) => {
	const caught = await run().catch((e: unknown) => e);
	expect(isRedirect(caught)).toBe(true);
	return (caught as Response & { options: { to: string } }).options.to;
};

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("/patient-access/$patientId", () => {
	const patient = { id: 7, name: "Ana", email: "ana@ktb.test" };
	const links = [
		{
			id: 1,
			email: "ana@ktb.test",
			relation: "self",
			status: "active",
			source: "invite",
		},
	];
	const load = () => options.loader({ params: { patientId: "7" } });

	it("lets a caller acting as a doctor through", async () => {
		mocks.doctorAccessFn.mockResolvedValue("doctor");
		await expect(options.beforeLoad()).resolves.toBeUndefined();
	});

	it("sends anonymous visitors to the doctor sign-in page", async () => {
		mocks.doctorAccessFn.mockResolvedValue("anonymous");
		expect(await redirectTarget(options.beforeLoad)).toBe("/login");
	});

	it("sends accounts with no doctor profile to the chooser", async () => {
		mocks.doctorAccessFn.mockResolvedValue("no-doctor");
		expect(await redirectTarget(options.beforeLoad)).toBe("/doctors/select");
	});

	it("loads the patient and its links with the locale and the vault flag", async () => {
		mocks.patientLinksFn.mockResolvedValue({ patient, links });
		await expect(load()).resolves.toEqual({
			patient,
			links,
			locale: "pt-BR",
			zk: false,
		});
		// The path param reaches the server fn as a number.
		expect(mocks.patientLinksFn).toHaveBeenCalledWith({ data: 7 });
		mocks.vaultStateFn.mockResolvedValue({ zk: true });
		await expect(load()).resolves.toMatchObject({ zk: true });
	});

	it("is a 404 for a patient that is not the acting doctor's", async () => {
		mocks.patientLinksFn.mockResolvedValue(null);
		expect(isNotFound(await load().catch((e: unknown) => e))).toBe(true);
	});

	it("wires the view to the server fns and refreshes on change", async () => {
		mocks.loaderData.current = { patient, links, locale: "en" };
		render(createElement(options.component));
		const props = mocks.props.current as {
			api: {
				invite(input: { email: string; relation: string }): Promise<unknown>;
				approve(id: number): Promise<unknown>;
				revoke(id: number): Promise<unknown>;
			};
			onChanged(): void;
		};
		expect(props).toMatchObject({ patient, links, locale: "en" });
		// Invites are bound to the patient the page was loaded for.
		await expect(
			props.api.invite({ email: "new@ktb.test", relation: "guardian" }),
		).resolves.toEqual({ ok: true });
		expect(mocks.invitePatientFn).toHaveBeenCalledWith({
			data: { patientId: 7, email: "new@ktb.test", relation: "guardian" },
		});
		await expect(props.api.approve(5)).resolves.toEqual({ ok: true });
		expect(mocks.approvePatientLinkFn).toHaveBeenCalledWith({ data: 5 });
		await expect(props.api.revoke(6)).resolves.toEqual({ ok: false });
		expect(mocks.revokePatientLinkFn).toHaveBeenCalledWith({ data: 6 });
		expect(mocks.invalidate).not.toHaveBeenCalled();
		props.onChanged();
		expect(mocks.invalidate).toHaveBeenCalledTimes(1);
	});

	it("on a ZK tenant masks the ciphered name and runs the grant pass", async () => {
		mocks.loaderData.current = {
			patient: { id: 7, name: "v1.name.ct", email: null },
			links,
			locale: "en",
			zk: true,
		};
		mocks.portalReadersFn.mockResolvedValue({
			readers: [{ readerId: "ana", wrapPublicKey: "pub" }],
			cipheredConsultationIds: [10],
		});
		render(createElement(options.component));
		// The raw envelope never reaches the view.
		expect((mocks.props.current as { patient: { name: string } }).patient.name).toBe(
			"Encrypted record",
		);
		await vi.waitFor(() => expect(mocks.portalReadersFn).toHaveBeenCalledWith({ data: 7 }));
		// No envelopes for this device → nothing gets granted, nothing throws.
		await vi.waitFor(() => expect(mocks.vaultDekEnvelopesFn).toHaveBeenCalled());
		expect(mocks.vaultGrantAccessFn).not.toHaveBeenCalled();
	});

	it("on a ZK tenant decrypts the record name this device can read", async () => {
		// A "clinic device" fixture grants the component's keyring: the
		// envelope is wrapped to whatever pubkey the effect sends.
		const grantor = makeKeyring({ store: memoryStore() });
		const dek = await generateDek();
		mocks.vaultDekEnvelopesFn.mockImplementation(
			async (call: {
				data: {
					entityType: string;
					entityIds: readonly (number | string)[];
					wrapPublicKey: string;
				};
			}): Promise<Record<string, string>> =>
				String(call.data.entityIds[0]) === "7"
					? { "7": await grantor.wrapKeyFor(dek, call.data.wrapPublicKey) }
					: {},
		);
		mocks.loaderData.current = {
			patient: { id: 7, name: await encrypt(dek, "Ana Real"), email: null },
			links,
			locale: "en",
			zk: true,
		};
		render(createElement(options.component));
		await vi.waitFor(() =>
			expect((mocks.props.current as { patient: { name: string } }).patient.name).toBe("Ana Real"),
		);
	});

	it("on a ZK tenant keeps a plaintext name and still runs the grant pass", async () => {
		mocks.loaderData.current = {
			patient: { id: 7, name: "Ana Plain", email: null },
			links,
			locale: "en",
			zk: true,
		};
		mocks.portalReadersFn.mockResolvedValue({
			readers: [{ readerId: "ana", wrapPublicKey: "pub" }],
			cipheredConsultationIds: [10],
		});
		render(createElement(options.component));
		expect((mocks.props.current as { patient: { name: string } }).patient.name).toBe("Ana Plain");
		await vi.waitFor(() => expect(mocks.portalReadersFn).toHaveBeenCalledWith({ data: 7 }));
		await vi.waitFor(() => expect(mocks.vaultDekEnvelopesFn).toHaveBeenCalled());
	});

	it("on a ZK tenant fails closed when the grant pass itself rejects", async () => {
		mocks.loaderData.current = {
			patient: { id: 7, name: "v1.name.ct", email: null },
			links,
			locale: "en",
			zk: true,
		};
		mocks.portalReadersFn.mockRejectedValue(new Error("down"));
		render(createElement(options.component));
		await vi.waitFor(() => expect(mocks.portalReadersFn).toHaveBeenCalledWith({ data: 7 }));
		// The page keeps the locked label — a failed pass never leaks.
		expect((mocks.props.current as { patient: { name: string } }).patient.name).toBe(
			"Encrypted record",
		);
	});

	it("on a ZK tenant skips the pass when the patient has no portal plan", async () => {
		mocks.loaderData.current = {
			patient: { id: 7, name: "v1.name.ct", email: null },
			links,
			locale: "en",
			zk: true,
		};
		mocks.portalReadersFn.mockResolvedValue(null);
		render(createElement(options.component));
		await vi.waitFor(() => expect(mocks.portalReadersFn).toHaveBeenCalled());
		expect(mocks.vaultGrantAccessFn).not.toHaveBeenCalled();
	});
});
