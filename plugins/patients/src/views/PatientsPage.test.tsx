// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, params, search: _search, ...props }: Record<string, unknown>) =>
			React.createElement(
				"a",
				{
					...props,
					href: String(to).replace("$id", String((params as { id?: string })?.id ?? "")),
				},
				props.children as never,
			),
	};
});

import type { KeyringService } from "@ktb/crypto/keyring";

const mocks = vi.hoisted(() => ({ decryptPatients: vi.fn() }));
// Real crypto needs WebCrypto (absent under jsdom) — the decrypt module
// is unit-tested in ../zk.test.ts; here we stub its entry point.
vi.mock("../zk.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../zk.ts")>();
	return { ...actual, decryptPatients: mocks.decryptPatients };
});

import { PatientsPage, type PatientListItem } from "./PatientsPage.tsx";
import type { PatientZkApi } from "../zk.ts";

const BASE: PatientListItem = {
	id: 1,
	name: "Maria Silva",
	socialName: null,
	gender: "female",
	birthDate: "1984-03-05",
	cpf: "52998224725",
	cns: null,
	active: true,
};

const item = (over: Partial<PatientListItem>): PatientListItem => ({ ...BASE, ...over });

import type { PatientDeleteApi } from "./DeletePatientDialog.tsx";

afterEach(() => {
	cleanup();
	mocks.decryptPatients.mockReset();
});

const actions = {
	deleteApi: {
		impact: vi.fn<PatientDeleteApi["impact"]>(async () => ({ consultations: 0 })),
		remove: vi.fn<PatientDeleteApi["remove"]>(async () => ({ ok: true })),
	},
	onDeleted: vi.fn<() => void>(),
};

describe("PatientsPage", () => {
	it("renders the empty state with a registration link", () => {
		render(<PatientsPage patients={[]} locale="en" {...actions} />);
		expect(screen.getByText("No patients yet.")).toBeTruthy();
		expect(screen.getByText("Register patient").getAttribute("href")).toBe("/patients/new");
		expect(screen.queryByLabelText("Search patients")).toBeNull();
	});

	it("lists patients with demographics, CPF and record badges", () => {
		render(
			<PatientsPage
				locale="en"
				{...actions}
				patients={[
					BASE,
					item({
						id: 2,
						name: "João Pereira",
						socialName: "Joana Pereira",
						gender: null,
						birthDate: null,
						cpf: null,
						active: false,
					}),
				]}
			/>,
		);
		expect(screen.getByText("2 patients registered.")).toBeTruthy();
		const maria = screen.getByText("Maria Silva");
		expect(maria.getAttribute("href")).toBe("/patients/1");
		expect(screen.getByText(/Female · \d+ years · CPF 529\.982\.247-25/)).toBeTruthy();
		// social name first, civil name as a hint
		expect(screen.getByText("Joana Pereira").getAttribute("href")).toBe("/patients/2");
		expect(screen.getByText("(João Pereira)")).toBeTruthy();
		expect(screen.getByText("No demographics recorded")).toBeTruthy();
		expect(screen.getByText("Inactive")).toBeTruthy();
		expect(screen.getByText("Incomplete record")).toBeTruthy();
		expect(screen.getByText("JP")).toBeTruthy();
	});

	it("renders in Portuguese for pt-BR", () => {
		render(
			<PatientsPage
				locale="pt-BR"
				{...actions}
				patients={[BASE, item({ id: 2, birthDate: null, gender: null, cpf: null, active: false })]}
			/>,
		);
		expect(screen.getByRole("heading", { name: "Pacientes" })).toBeTruthy();
		expect(screen.getByText("2 pacientes cadastrados.")).toBeTruthy();
		expect(screen.getByText(/Feminino · \d+ anos · CPF 529\.982\.247-25/)).toBeTruthy();
		expect(screen.getByLabelText("Buscar pacientes")).toBeTruthy();
		expect(screen.getByText("Novo paciente")).toBeTruthy();
		expect(screen.getByText("Inativo")).toBeTruthy();
		expect(screen.getByText("Cadastro incompleto")).toBeTruthy();
		expect(screen.getByText("Sem dados demográficos registrados")).toBeTruthy();
	});

	it("uses the singular count", () => {
		render(<PatientsPage patients={[BASE]} locale="en" {...actions} />);
		expect(screen.getByText("1 patient registered.")).toBeTruthy();
	});

	it("offers edit, export and delete actions per patient", async () => {
		const user = userEvent.setup();
		const deleteApi = {
			impact: vi.fn<PatientDeleteApi["impact"]>(async () => ({ consultations: 2 })),
			remove: vi.fn<PatientDeleteApi["remove"]>(async () => ({ ok: true })),
		};
		const onDeleted = vi.fn<(id: number) => void>();
		render(
			<PatientsPage
				patients={[BASE, item({ id: 2, name: "João Pereira", socialName: "Joana Pereira" })]}
				locale="en"
				deleteApi={deleteApi}
				onDeleted={onDeleted}
			/>,
		);
		// Edit and delete are visible icon actions; export stays in the row menu.
		expect(screen.getByRole("link", { name: "Edit Joana Pereira" }).getAttribute("href")).toBe(
			"/patients/2/edit",
		);
		await user.click(screen.getByRole("button", { name: "Actions for Joana Pereira" }));
		const fhir = await screen.findByRole("menuitem", { name: "HL7 FHIR R4 (JSON)" });
		expect(fhir.getAttribute("href")).toBe("/api/patients/2/export?format=fhir-r4");
		expect(fhir.hasAttribute("download")).toBe(true);
		expect(
			(await screen.findByRole("menuitem", { name: "openEHR (JSON)" })).getAttribute("href"),
		).toBe("/api/patients/2/export?format=openehr");

		await user.click(screen.getByRole("button", { name: "Delete Joana Pereira" }));
		expect(
			await screen.findByText("This permanently deletes the record of Joana Pereira."),
		).toBeTruthy();
		await user.click(await screen.findByRole("checkbox"));
		await user.click(screen.getByRole("button", { name: "Delete permanently" }));
		expect(deleteApi.remove).toHaveBeenCalledWith(2);
		expect(onDeleted).toHaveBeenCalledWith(2);
		expect(screen.queryByText("This permanently deletes the record of Joana Pereira.")).toBeNull();
	});

	it("closes the delete dialog on cancel", async () => {
		const user = userEvent.setup();
		render(<PatientsPage patients={[BASE]} locale="pt-BR" {...actions} />);
		await user.click(screen.getByRole("button", { name: "Excluir Maria Silva" }));
		await user.click(await screen.findByRole("button", { name: "Cancelar" }));
		expect(screen.queryByText("Excluir paciente?")).toBeNull();
	});

	it("searches by name, social name, CPF and CNS", async () => {
		const user = userEvent.setup();
		render(
			<PatientsPage
				locale="en"
				{...actions}
				patients={[
					BASE,
					item({ id: 2, name: "Ana Costa", socialName: "Nina", cpf: null, cns: "100000000000007" }),
				]}
			/>,
		);
		const search = screen.getByLabelText("Search patients");

		await user.type(search, "nina");
		expect(screen.queryByText("Maria Silva")).toBeNull();
		expect(screen.getByText("Nina")).toBeTruthy();

		await user.clear(search);
		await user.type(search, "529.982");
		expect(screen.getByText("Maria Silva")).toBeTruthy();
		expect(screen.queryByText("Nina")).toBeNull();

		await user.clear(search);
		await user.type(search, "1000000");
		expect(screen.getByText("Nina")).toBeTruthy();

		await user.clear(search);
		await user.type(search, "zzz");
		expect(screen.getByText("No patients match the search.")).toBeTruthy();

		await user.clear(search);
		expect(screen.getByText("Maria Silva")).toBeTruthy();
	});

	describe("PatientsPage under ZK (T-144)", () => {
		const zkApi = (over: Partial<PatientZkApi> = {}): PatientZkApi => ({
			devices: vi.fn(async () => []),
			dekEnvelopes: vi.fn(async () => ({})),
			grant: vi.fn(async () => ({ ok: true })),
			...over,
		});
		const keyring = {} as unknown as KeyringService;

		it("renders a locked, non-navigable card when the device has no grant", async () => {
			const row = item({ name: "v1.YWFh.YmJi" });
			mocks.decryptPatients.mockResolvedValue([row]);
			render(
				<PatientsPage locale="en" {...actions} zk={{ keyring, api: zkApi() }} patients={[row]} />,
			);
			expect(await screen.findByText("Encrypted record")).toBeTruthy();
			expect(screen.getByText("Unlock it on an approved clinic device to view it.")).toBeTruthy();
			// Opaque: no link into the record, no envelope text leaked.
			expect(screen.queryByRole("link", { name: /v1\./ })).toBeNull();
			expect(screen.queryByText("v1.YWFh.YmJi")).toBeNull();
			expect(mocks.decryptPatients).toHaveBeenCalledWith(keyring, expect.anything(), [row]);
		});

		it("decrypts granted rows and re-sorts the decrypted names", async () => {
			mocks.decryptPatients.mockImplementation(
				async (_k: unknown, _a: unknown, rows: PatientListItem[]) =>
					rows.map((r) =>
						r.id === 1 ? { ...r, name: "Zelma Campos", birthDate: "1970-01-01" } : r,
					),
			);
			render(
				<PatientsPage
					locale="en"
					{...actions}
					zk={{ keyring, api: zkApi() }}
					patients={[item({ name: "v1.YWFh.YmJi" }), item({ id: 2, name: "Ana" })]}
				/>,
			);
			expect(await screen.findByText("Zelma Campos")).toBeTruthy();
			// Decrypted "Ana" sorts before "Zelma" despite wire order.
			const names = screen.getAllByRole("link").map((a) => a.textContent);
			expect(names.indexOf("Ana")).toBeLessThan(names.indexOf("Zelma Campos"));
		});

		it("keeps rows locked when the decrypt call fails", async () => {
			mocks.decryptPatients.mockRejectedValue(new Error("offline"));
			render(
				<PatientsPage
					locale="en"
					{...actions}
					zk={{ keyring, api: zkApi() }}
					patients={[item({ name: "v1.YWFh.YmJi" })]}
				/>,
			);
			expect(await screen.findByText("Encrypted record")).toBeTruthy();
		});

		it("ignores decrypt results arriving after unmount", async () => {
			let resolve: ((rows: PatientListItem[]) => void) | undefined;
			mocks.decryptPatients.mockImplementation(
				() => new Promise<PatientListItem[]>((r) => (resolve = r)),
			);
			const { unmount } = render(
				<PatientsPage
					locale="en"
					{...actions}
					zk={{ keyring, api: zkApi() }}
					patients={[item({ name: "v1.YWFh.YmJi" })]}
				/>,
			);
			unmount();
			resolve?.([item({ id: 1, name: "Late" })]);
			await Promise.resolve();
			expect(mocks.decryptPatients).toHaveBeenCalledOnce();
		});
	});
});
