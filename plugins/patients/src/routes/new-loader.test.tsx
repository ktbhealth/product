import { describe, expect, it, vi } from "vitest";

const localeFn = vi.hoisted(() => vi.fn(async () => "pt-BR"));
const vaultStateFn = vi.hoisted(() =>
	vi.fn(async () => ({ tenantId: 7, role: "admin", zk: false })),
);

vi.mock("../fns.ts", () => ({ localeFn }));
vi.mock("../guard.ts", () => ({ requireDoctor: vi.fn() }));
vi.mock("../apis.ts", () => ({ newPatientApi: {}, patientsZkApi: {} }));
vi.mock("@ktb/vault/fns", () => ({ vaultStateFn }));
vi.mock("@ktb/crypto/keyring", () => ({ makeKeyring: vi.fn() }));
vi.mock("../views/index.ts", () => ({ PatientFormPage: () => null }));
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
		useNavigate: () => vi.fn(),
		createFileRoute: () => (opts: Record<string, unknown>) => ({ options: opts }),
	};
});

import { Route } from "./new.tsx";

describe("/patients/new loader", () => {
	it("attaches the active locale and zk flag to the route data", async () => {
		const { loader } = (
			Route as unknown as {
				options: { loader: () => Promise<{ locale: string; zk: boolean }> };
			}
		).options;
		await expect(loader()).resolves.toEqual({ locale: "pt-BR", zk: false });
		expect(localeFn).toHaveBeenCalledOnce();
	});
});
