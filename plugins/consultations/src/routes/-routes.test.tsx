// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConsultationFn: vi.fn(),
	patientHistoryFn: vi.fn(),
	listConsultationsFn: vi.fn(async () => []),
	localeFn: vi.fn(),
	patientHistoryRowsFn: vi.fn(),
	vaultStateFn: vi.fn(async () => ({ tenantId: 7, role: "admin", zk: false })),
	loaderData: { current: undefined as unknown },
	props: { current: undefined as Record<string, unknown> | undefined },
	listProps: { current: undefined as Record<string, unknown> | undefined },
	newProps: { current: undefined as Record<string, unknown> | undefined },
	decryptPatients: vi.fn(async (_k: unknown, _api: unknown, rows: unknown[]) => rows),
	isCipheredPatient: vi.fn(() => false),
	resolveByokExtractor: vi.fn(async () => ({ tag: "extractor" })),
}));

vi.mock("../guard.ts", () => ({ requireDoctor: vi.fn() }));
vi.mock("../fns.ts", () => ({
	getConsultationFn: mocks.getConsultationFn,
	patientHistoryFn: mocks.patientHistoryFn,
	patientHistoryRowsFn: mocks.patientHistoryRowsFn,
	attachAnamnesisFn: vi.fn(),
	listConsultationsFn: mocks.listConsultationsFn,
	extractAnamnesisFn: vi.fn(),
	getLiveConsultationFn: vi.fn(),
	recordConsentFn: vi.fn(),
	saveConsultationFn: vi.fn(),
	sessionUserFn: vi.fn(),
	localeFn: mocks.localeFn,
}));
vi.mock("@ktb/patients/zk", () => ({
	decryptPatients: mocks.decryptPatients,
	isCipheredPatient: mocks.isCipheredPatient,
}));
vi.mock("../backend.ts", () => ({
	prefersWhisper: false,
	transcriptionBackend: undefined,
}));
vi.mock("../byok.ts", () => ({ resolveByokExtractor: mocks.resolveByokExtractor }));
vi.mock("@ktb/anamnesis-llm/byok", () => ({ makeByokExtractor: vi.fn(() => ({})) }));
vi.mock("@ktb/transcription-webspeech", () => ({ webSpeechBackend: { id: "web-speech" } }));
vi.mock("@ktb/patient-access/fns", () => ({
	invitePatientFn: vi.fn(async () => ({ ok: true })),
	patientLinksFn: vi.fn(async () => []),
}));
vi.mock("@ktb/patients/fns", () => ({
	createPatientFn: vi.fn(async () => ({ ok: true, patient: { id: 1, name: "p" } })),
	listPatientsFn: vi.fn(async () => []),
}));
vi.mock("@ktb/vault/fns", () => ({
	vaultStateFn: mocks.vaultStateFn,
	vaultDevicesFn: vi.fn(),
	vaultDekEnvelopesFn: vi.fn(),
	vaultGrantAccessFn: vi.fn(),
}));
vi.mock("@ktb/crypto/keyring", () => ({ makeKeyring: vi.fn(() => ({ tag: "keyring" })) }));
vi.mock("../whisper-prefetch.ts", () => ({ prefetchWhisperModel: vi.fn() }));
vi.mock("@ktb/transcription-whisper", () => ({ whisperBackend: { id: "whisper" } }));
vi.mock("../views/index.ts", () => ({
	ConsultationDetailPage: (props: Record<string, unknown>) => {
		mocks.props.current = props;
		return createElement("div");
	},
	ConsultationsPage: (props: Record<string, unknown>) => {
		mocks.listProps.current = props;
		return createElement("div");
	},
	NewConsultationPage: (props: Record<string, unknown>) => {
		mocks.newProps.current = props;
		return createElement("div");
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
				h({ data: validate === undefined ? call?.data : validate(call?.data) }),
		};
		return api;
	},
}));
vi.mock("@tanstack/react-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@tanstack/react-router")>();
	return {
		...actual,
		createFileRoute: () => (opts: Record<string, unknown>) => ({
			options: opts,
			useLoaderData: () => mocks.loaderData.current,
			useSearch: () => ({}),
		}),
	};
});

import { Route as DetailRoute } from "./$id.tsx";
import { Route as ListRoute } from "./index.tsx";
import { Route as NewRoute } from "./new.tsx";
import { newConsultationApi } from "../apis.ts";

type Opts = {
	staleTime: number;
	beforeLoad: () => unknown;
	loader: (a: { params: { id: string } }) => Promise<unknown>;
	component: () => ReactElement;
};
const opts = (DetailRoute as unknown as { options: Opts }).options;

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

describe("/consultations/$id", () => {
	it("caches the loader result for 30s and guards the session", () => {
		expect(opts.staleTime).toBe(30_000);
		expect(() => opts.beforeLoad()).not.toThrow();
	});

	it("throws notFound when the consultation does not exist", async () => {
		mocks.getConsultationFn.mockResolvedValue(null);
		await expect(opts.loader({ params: { id: "9" } })).rejects.toMatchObject({ isNotFound: true });
		expect(mocks.getConsultationFn).toHaveBeenCalledWith({ data: 9 });
	});

	it("skips the history for a consultation without a patient", async () => {
		const c = { id: 9, patientId: null };
		mocks.getConsultationFn.mockResolvedValue(c);
		await expect(opts.loader({ params: { id: "9" } })).resolves.toEqual({
			c,
			history: null,
			historyRows: null,
			locale: undefined,
			zk: false,
		});
		expect(mocks.patientHistoryFn).not.toHaveBeenCalled();
	});

	it("loads the patient history, excluding the current consultation", async () => {
		const c = { id: 9, patientId: 4 };
		mocks.getConsultationFn.mockResolvedValue(c);
		mocks.patientHistoryFn.mockResolvedValue({ items: [] });
		await expect(opts.loader({ params: { id: "9" } })).resolves.toEqual({
			c,
			history: { items: [] },
			historyRows: null,
			locale: undefined,
			zk: false,
		});
		expect(mocks.patientHistoryFn).toHaveBeenCalledWith({
			data: { patientId: 4, excludeId: 9 },
		});
	});

	it("loads raw history rows instead of the summary under ZK", async () => {
		mocks.vaultStateFn.mockResolvedValueOnce({ tenantId: 7, role: "admin", zk: true });
		const c = { id: 9, patientId: 4 };
		mocks.getConsultationFn.mockResolvedValue(c);
		mocks.patientHistoryRowsFn.mockResolvedValue({ count: 1, rows: [] });
		await expect(opts.loader({ params: { id: "9" } })).resolves.toEqual({
			c,
			history: null,
			historyRows: { count: 1, rows: [] },
			locale: undefined,
			zk: true,
		});
		expect(mocks.patientHistoryRowsFn).toHaveBeenCalledWith({
			data: { patientId: 4, excludeId: 9 },
		});
		expect(mocks.patientHistoryFn).not.toHaveBeenCalled();
	});

	it("renders the detail page with a live-refetch api backed by getConsultationFn", async () => {
		mocks.loaderData.current = { c: { id: 9 }, history: null, historyRows: null, zk: false };
		mocks.getConsultationFn.mockResolvedValue({ id: 9, audioStatus: "done" });
		render(createElement(opts.component));
		const props = mocks.props.current!;
		expect(props.c).toEqual({ id: 9 });
		expect(props.history).toBeNull();
		expect(props.zk).toBeUndefined();
		const api = props.api as { getConsultation: (i: { data: number }) => Promise<unknown> };
		await expect(api.getConsultation({ data: 9 })).resolves.toEqual({ id: 9, audioStatus: "done" });
		expect(mocks.getConsultationFn).toHaveBeenCalledWith({ data: 9 });
	});

	it("passes a keyring-bound zk surface to the detail page under ZK", async () => {
		mocks.loaderData.current = { c: { id: 9 }, history: null, historyRows: null, zk: true };
		render(createElement(opts.component));
		const props = mocks.props.current!;
		const zk = props.zk as { keyring: unknown; api: unknown } | undefined;
		expect(zk?.keyring).toEqual({ tag: "keyring" });
		expect(zk?.api).toBeDefined();
	});
});

describe("newConsultationApi", () => {
	it("delegates getConsultation to the server fn", async () => {
		mocks.getConsultationFn.mockResolvedValue({ id: 3 });
		await expect(newConsultationApi.getConsultation!({ data: 3 })).resolves.toEqual({ id: 3 });
		expect(mocks.getConsultationFn).toHaveBeenCalledWith({ data: 3 });
	});
});

describe("/consultations/", () => {
	const opts = (ListRoute as unknown as { options: Opts }).options;

	it("renders the list page without a zk surface for plain tenants", () => {
		mocks.loaderData.current = { consultations: [], locale: "en", zk: false };
		render(createElement(opts.component));
		expect(mocks.listProps.current?.zk).toBeUndefined();
	});

	it("binds a device keyring to the list page under ZK", () => {
		mocks.loaderData.current = { consultations: [], locale: "en", zk: true };
		render(createElement(opts.component));
		const zk = mocks.listProps.current?.zk as { keyring: unknown; api: unknown } | undefined;
		expect(zk?.keyring).toEqual({ tag: "keyring" });
		expect(zk?.api).toBeDefined();
	});

	it("loads consultations, locale and vault state, and guards the session", async () => {
		mocks.listConsultationsFn.mockResolvedValueOnce([{ id: 1 }] as never);
		mocks.localeFn.mockResolvedValueOnce("en");
		mocks.vaultStateFn.mockResolvedValueOnce({ tenantId: 7, role: "admin", zk: true });
		await expect(opts.loader({ params: {} as { id: string } })).resolves.toEqual({
			consultations: [{ id: 1 }],
			locale: "en",
			zk: true,
		});
		await expect(opts.beforeLoad() as Promise<unknown>).resolves.toBeUndefined();
	});
});

describe("/consultations/new", () => {
	const opts = (NewRoute as unknown as { options: Opts }).options;

	it("passes patients through unchanged for plain tenants", () => {
		const patients = [{ id: 1, name: "Maria" }];
		mocks.loaderData.current = { initialPatients: patients, locale: "en", zk: false };
		render(createElement(opts.component));
		expect(mocks.newProps.current?.initialPatients).toEqual(patients);
		expect(mocks.decryptPatients).not.toHaveBeenCalled();
	});

	it("decrypts patient names for the picker under ZK", async () => {
		mocks.decryptPatients.mockResolvedValueOnce([{ id: 1, name: "Maria" }] as never);
		mocks.loaderData.current = {
			initialPatients: [{ id: 1, name: "v1.aa.bb" }],
			locale: "en",
			zk: true,
		};
		render(createElement(opts.component));
		await waitFor(() =>
			expect(mocks.newProps.current?.initialPatients).toEqual([{ id: 1, name: "Maria" }]),
		);
		expect(mocks.decryptPatients).toHaveBeenCalledWith({ tag: "keyring" }, expect.anything(), [
			{ id: 1, name: "v1.aa.bb" },
		]);
	});

	it("labels still-ciphered patients as locked", async () => {
		mocks.isCipheredPatient.mockImplementationOnce(() => true);
		mocks.decryptPatients.mockResolvedValueOnce([{ id: 1, name: "v1.aa.bb" }] as never);
		mocks.loaderData.current = {
			initialPatients: [{ id: 1, name: "v1.aa.bb" }],
			locale: "en",
			zk: true,
		};
		render(createElement(opts.component));
		await waitFor(() =>
			expect(mocks.newProps.current?.initialPatients).toEqual([
				{ id: 1, name: "Encrypted record" },
			]),
		);
	});

	it("binds the resolved BYOK extractor to the page under ZK", async () => {
		mocks.loaderData.current = {
			initialPatients: [],
			locale: "en",
			zk: true,
		};
		render(createElement(opts.component));
		await waitFor(() => expect(mocks.resolveByokExtractor).toHaveBeenCalled());
		await waitFor(() =>
			expect(
				(mocks.newProps.current?.zk as { extractor?: unknown } | undefined)?.extractor,
			).toEqual({ tag: "extractor" }),
		);
	});

	it("keeps the heuristic extractor when BYOK resolution fails", async () => {
		mocks.resolveByokExtractor.mockRejectedValueOnce(new Error("no key"));
		mocks.loaderData.current = {
			initialPatients: [],
			locale: "en",
			zk: true,
		};
		render(createElement(opts.component));
		await waitFor(() => expect(mocks.resolveByokExtractor).toHaveBeenCalled());
		await act(async () => {});
		expect(
			(mocks.newProps.current?.zk as { extractor?: unknown } | undefined)?.extractor,
		).toBeUndefined();
	});

	it("ignores late extractor resolutions after unmount", async () => {
		let resolve: (e: { tag: string }) => void = () => {};
		mocks.resolveByokExtractor.mockImplementationOnce(
			() =>
				new Promise<{ tag: string }>((r) => {
					resolve = r;
				}),
		);
		mocks.loaderData.current = {
			initialPatients: [],
			locale: "en",
			zk: true,
		};
		const { unmount } = render(createElement(opts.component));
		unmount();
		await act(async () => {
			resolve({ tag: "extractor" });
		});
	});

	it("ignores late patient decryptions after unmount", async () => {
		let resolve: (rows: unknown[]) => void = () => {};
		mocks.decryptPatients.mockImplementationOnce(
			() =>
				new Promise<unknown[]>((r) => {
					resolve = r;
				}),
		);
		mocks.loaderData.current = {
			initialPatients: [{ id: 1, name: "v1.aa.bb" }],
			locale: "en",
			zk: true,
		};
		const { unmount } = render(createElement(opts.component));
		unmount();
		await act(async () => {
			resolve([]);
		});
	});

	it("loads initial patients, locale and vault state, and guards the session", async () => {
		mocks.localeFn.mockResolvedValueOnce("en");
		mocks.vaultStateFn.mockResolvedValueOnce({ tenantId: 7, role: "admin", zk: false });
		await expect(opts.loader({ params: {} as { id: string } })).resolves.toEqual({
			initialPatients: [],
			locale: "en",
			zk: false,
		});
		await expect(opts.beforeLoad() as Promise<unknown>).resolves.toBeUndefined();
	});

	it("keeps the picker rows when patient decryption fails", async () => {
		mocks.decryptPatients.mockRejectedValueOnce(new Error("no key"));
		mocks.loaderData.current = {
			initialPatients: [{ id: 1, name: "v1.aa.bb" }],
			locale: "en",
			zk: true,
		};
		render(createElement(opts.component));
		await waitFor(() => expect(mocks.decryptPatients).toHaveBeenCalled());
		await act(async () => {});
		expect(mocks.newProps.current?.initialPatients).toEqual([{ id: 1, name: "v1.aa.bb" }]);
	});
});
