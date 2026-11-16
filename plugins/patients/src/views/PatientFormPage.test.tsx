// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
	};
});

import type { KeyringService } from "@ktb/crypto/keyring";

const mocks = vi.hoisted(() => ({
	decryptPatient: vi.fn(),
	encryptPatientDraft: vi.fn(),
	newPatientDek: vi.fn(),
	patientDek: vi.fn(),
}));
// WebCrypto is absent under jsdom — stub the zk module's crypto entry
// points (unit-tested in ../zk.test.ts) and keep real row detection.
vi.mock("../zk.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../zk.ts")>();
	return {
		...actual,
		decryptPatient: mocks.decryptPatient,
		encryptPatientDraft: mocks.encryptPatientDraft,
		newPatientDek: mocks.newPatientDek,
		patientDek: mocks.patientDek,
	};
});

import { makePatient } from "../testing.ts";
import { PatientFormPage, type PatientFormApi } from "./PatientFormPage.tsx";
import type { PatientZkApi } from "../zk.ts";

type Save = PatientFormApi["save"];

afterEach(() => {
	cleanup();
	vi.clearAllMocks();
});

const YEAR = new Date().getFullYear();

const setup = (
	api: PatientFormApi,
	patient?: Parameters<typeof PatientFormPage>[0]["patient"],
	locale = "en",
) => {
	const onSaved = vi.fn<(id: number) => void>();
	const user = userEvent.setup();
	render(<PatientFormPage patient={patient} api={api} onSaved={onSaved} locale={locale} />);
	return { user, onSaved };
};

/** Label lookup tolerant of the decorative required marker ("Full name*"). */
const input = (label: string) =>
	screen.getByLabelText(
		new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\*?$`),
	) as HTMLInputElement;

type User = ReturnType<typeof userEvent.setup>;

/** Label shown by a design-system Select (its value slot, not the trigger's icon). */
const shown = (label: string) =>
	input(label).querySelector('[data-slot="select-value"]')?.textContent;

/** Picks an option from a design-system Select (trigger is labelled by the field). */
const choose = async (user: User, label: string, option: string) => {
	await user.click(input(label));
	await user.click(await screen.findByRole("option", { name: option }));
};

/** Picks an exact day from the birth-date Calendar popover. */
const pickDate = async (user: User, year: number, month: string, day: number) => {
	await user.click(input("Birth date"));
	await user.selectOptions(await screen.findByRole("combobox", { name: /year/i }), String(year));
	await user.selectOptions(screen.getByRole("combobox", { name: /month/i }), month);
	await user.click(
		screen.getByRole("button", { name: new RegExp(`${month} ${day}\\w*, ${year}`) }),
	);
};

describe("PatientFormPage — registration", () => {
	it("starts with Brazilian defaults and no active toggle", () => {
		setup({ save: vi.fn<Save>() });
		expect(screen.getByRole("heading", { name: "New patient" })).toBeTruthy();
		expect(shown("Country")).toBe("Brazil");
		expect(shown("Nationality")).toBe("Brazil");
		expect(shown("Preferred language")).toBe("Portuguese (Brazil)");
		expect(shown("Sex (administrative)")).toBe("—");
		expect(input("Birth date").textContent).toBe("Pick a date");
		expect(screen.getByLabelText("CEP")).toBeTruthy();
		// Brazil → state is a UF select
		expect(screen.getByRole("combobox", { name: "State" })).toBeTruthy();
		expect(screen.queryByText("Active record")).toBeNull();
		expect(screen.getByText("Cancel").getAttribute("href")).toBe("/patients");
	});

	it("blocks submit with inline errors when name and birth date are missing", async () => {
		const save = vi.fn<Save>();
		const { user } = setup({ save });
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(screen.getByText("Name is required.")).toBeTruthy();
		expect(screen.getByText("Birth date (or age) is required.")).toBeTruthy();
		expect(screen.getByText("Please fix the highlighted fields.")).toBeTruthy();
		expect(input("Full name").getAttribute("aria-invalid")).toBe("true");
		expect(save).not.toHaveBeenCalled();
	});

	it("registers by name + age as a year-only FHIR birth date", async () => {
		const save = vi.fn<Save>().mockResolvedValue({ ok: true, patient: { id: 42 } });
		const { user, onSaved } = setup({ save });
		await user.type(input("Full name"), "Ana Souza");
		await user.type(input("Age in years"), "40");
		expect(
			screen.getByText(`Recorded as ${YEAR - 40} (approximate). Enter the exact date if known.`),
		).toBeTruthy();
		await choose(user, "Sex (administrative)", "Female");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({
				name: "Ana Souza",
				birthDate: String(YEAR - 40),
				gender: "female",
				active: true,
			}),
		);
		expect(onSaved).toHaveBeenCalledWith(42);
	});

	it("an exact date replaces the age; clearing the age clears the birth date", async () => {
		const { user } = setup({ save: vi.fn<Save>() });
		await user.type(input("Age in years"), "30");
		await pickDate(user, 1990, "May", 10);
		expect(input("Age in years").value).toBe("");
		expect(input("Birth date").textContent).toBe("10/05/1990");
		expect(screen.queryByText(/approximate/)).toBeNull();

		await user.type(input("Age in years"), "5");
		await user.clear(input("Age in years"));
		await user.type(input("Full name"), "X");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(screen.getByText("Birth date (or age) is required.")).toBeTruthy();
	});

	it("validates identifiers on the client", async () => {
		const save = vi.fn<Save>();
		const { user } = setup({ save });
		await user.type(input("Full name"), "Ana");
		await user.type(input("Age in years"), "40");
		await user.type(input("CPF"), "123.456.789-00");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(screen.getByText("Invalid CPF.")).toBeTruthy();
		expect(save).not.toHaveBeenCalled();
	});

	it("switches to free-form state and postal code outside Brazil", async () => {
		const { user } = setup({ save: vi.fn<Save>() });
		await choose(user, "Country", "Portugal");
		expect(screen.getByLabelText("State / province").tagName).toBe("INPUT");
		expect(screen.getByLabelText("Postal code")).toBeTruthy();
	});

	it("shows server-side field errors", async () => {
		const save = vi.fn<Save>().mockResolvedValue({
			ok: false,
			errors: { email: "invalid_email", maritalStatus: "invalid_option" },
		});
		const { user, onSaved } = setup({ save });
		await user.type(input("Full name"), "Ana");
		await user.type(input("Age in years"), "40");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(await screen.findByText("Invalid email.")).toBeTruthy();
		expect(screen.getByText("Choose a valid option.")).toBeTruthy();
		expect(input("Marital status").getAttribute("aria-invalid")).toBe("true");
		expect(screen.getByText("Please fix the highlighted fields.")).toBeTruthy();
		expect(onSaved).not.toHaveBeenCalled();
	});

	it("reports a rejected save without field errors", async () => {
		const save = vi.fn<Save>().mockResolvedValue({ ok: false, errors: {} });
		const { user } = setup({ save });
		await user.type(input("Full name"), "Ana");
		await user.type(input("Age in years"), "40");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(await screen.findByText("Could not save the patient.")).toBeTruthy();
	});

	it("reports a failed request", async () => {
		const save = vi.fn<Save>().mockRejectedValue(new Error("network"));
		const { user } = setup({ save });
		await user.type(input("Full name"), "Ana");
		await user.type(input("Age in years"), "40");
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		expect(await screen.findByText("Could not save the patient. Try again.")).toBeTruthy();
		expect(
			(screen.getByRole("button", { name: "Register patient" }) as HTMLButtonElement).disabled,
		).toBe(false);
	});
});

describe("PatientFormPage — edit", () => {
	const patient = makePatient({
		id: 7,
		name: "Maria Silva",
		birthDate: "1984",
		gender: "female",
		country: "US",
		state: "CA",
		cpf: "52998224725",
	});

	it("prefills the record, including an approximate birth date", () => {
		setup({ save: vi.fn<Save>() }, patient);
		expect(screen.getByRole("heading", { name: "Edit patient" })).toBeTruthy();
		expect(input("Full name").value).toBe("Maria Silva");
		expect(input("CPF").value).toBe("52998224725");
		expect(input("Birth date").textContent).toBe("Pick a date");
		expect(input("Age in years").value).toBe(String(YEAR - 1984));
		expect(
			screen.getByText("Recorded as 1984 (approximate). Enter the exact date if known."),
		).toBeTruthy();
		expect(input("State / province").value).toBe("CA");
		expect(screen.getByText("Cancel").getAttribute("href")).toBe("/patients/7");
	});

	it("prefills an exact birth date without an age; re-picking the day clears it", async () => {
		const { user } = setup({ save: vi.fn<Save>() }, makePatient({ birthDate: "1984-03-05" }));
		expect(input("Birth date").textContent).toBe("05/03/1984");
		expect(input("Age in years").value).toBe("");

		await user.click(input("Birth date"));
		await user.click(await screen.findByRole("button", { name: /March 5\w*, 1984/ }));
		expect(input("Birth date").textContent).toBe("Pick a date");
	});

	it("clears a coded field back to empty", async () => {
		const save = vi.fn<Save>().mockResolvedValue({ ok: true, patient: { id: 7 } });
		const { user } = setup({ save }, patient);
		expect(shown("Sex (administrative)")).toBe("Female");
		await choose(user, "Sex (administrative)", "—");
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(save).toHaveBeenCalledWith(expect.objectContaining({ gender: "" }));
	});

	it("can deactivate the record and save changes", async () => {
		const save = vi.fn<Save>().mockResolvedValue({ ok: true, patient: { id: 7 } });
		const { user, onSaved } = setup({ save }, patient);
		await user.click(screen.getByRole("checkbox"));
		await user.clear(input("Full name"));
		await user.type(input("Full name"), "Maria S. Lima");
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ name: "Maria S. Lima", active: false, birthDate: "1984" }),
		);
		expect(onSaved).toHaveBeenCalledWith(7);
	});
});

describe("PatientFormPage — pt-BR", () => {
	it("renders labels, options and the calendar in Portuguese", async () => {
		const { user } = setup({ save: vi.fn<Save>() }, undefined, "pt-BR");
		expect(screen.getByRole("heading", { name: "Novo paciente" })).toBeTruthy();
		expect(shown("País")).toBe("Brasil");
		expect(shown("Idioma preferido")).toBe("Português (Brasil)");
		expect(input("Data de nascimento").textContent).toBe("Selecione uma data");
		expect(screen.getByRole("combobox", { name: "Estado" })).toBeTruthy();
		expect(screen.getByText("Contato de emergência")).toBeTruthy();

		await user.click(input("Data de nascimento"));
		expect(screen.getByRole("combobox", { name: "Escolha o ano" })).toBeTruthy();
		await user.keyboard("{Escape}");

		await choose(user, "Sexo (administrativo)", "Feminino");
		expect(shown("Sexo (administrativo)")).toBe("Feminino");
	});

	it("shows local and server validation errors in Portuguese", async () => {
		const save = vi.fn<Save>().mockResolvedValue({ ok: false, errors: { email: "invalid_email" } });
		const { user } = setup({ save }, undefined, "pt-BR");
		await user.click(screen.getByRole("button", { name: "Cadastrar paciente" }));
		expect(screen.getByText("O nome é obrigatório.")).toBeTruthy();
		expect(screen.getByText("A data de nascimento (ou idade) é obrigatória.")).toBeTruthy();
		expect(screen.getByText("Corrija os campos destacados.")).toBeTruthy();

		await user.type(input("Nome completo"), "Ana");
		await user.type(input("Idade em anos"), "40");
		expect(
			screen.getByText(
				`Registrado como ${YEAR - 40} (aproximado). Informe a data exata, se souber.`,
			),
		).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Cadastrar paciente" }));
		expect(await screen.findByText("E-mail inválido.")).toBeTruthy();
	});

	it("reports failed saves in Portuguese", async () => {
		const save = vi
			.fn<Save>()
			.mockResolvedValueOnce({ ok: false, errors: {} })
			.mockRejectedValueOnce(new Error("network"));
		const { user } = setup({ save }, makePatient({ birthDate: "1984" }), "pt-BR");
		expect(screen.getByRole("heading", { name: "Editar paciente" })).toBeTruthy();
		expect(screen.getByText("Cadastro ativo")).toBeTruthy();
		expect(screen.getByText("Cancelar")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
		expect(await screen.findByText("Não foi possível salvar o paciente.")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Salvar alterações" }));
		expect(
			await screen.findByText("Não foi possível salvar o paciente. Tente novamente."),
		).toBeTruthy();
	});
});

describe("PatientFormPage — ZK (T-144)", () => {
	const zkApi: PatientZkApi = {
		devices: vi.fn(async () => []),
		dekEnvelopes: vi.fn(async () => ({})),
		grant: vi.fn(async () => ({ ok: true })),
	};
	const keyring = {} as unknown as KeyringService;
	const zk = { keyring, api: zkApi };
	const dek = {} as CryptoKey;
	const grant = { readerKind: "device" as const, readerPubkey: "pub-1", wrappedDek: "w1.x.y" };
	const ciphered = makePatient({ id: 7, name: "v1.YWFh.YmJi", birthDate: "v1.Y2Jk" });

	const fillRequired = async (user: User) => {
		await user.type(input("Full name"), "Ana Souza");
		await user.type(input("Age in years"), "40");
	};

	it("shows a spinner while the record decrypts, then mounts the form", async () => {
		let resolve: ((p: typeof ciphered | null) => void) | undefined;
		mocks.decryptPatient.mockImplementation(
			() => new Promise<typeof ciphered | null>((r) => (resolve = r)),
		);
		render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		expect(screen.getByRole("status")).toBeTruthy();
		resolve?.(makePatient({ id: 7, name: "Decrypted Name", birthDate: "1984" }));
		expect(await screen.findByDisplayValue("Decrypted Name")).toBeTruthy();
	});

	it("fails loud when the record cannot be decrypted", async () => {
		mocks.decryptPatient.mockResolvedValue(null);
		render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		expect(
			await screen.findByText("This record could not be decrypted on this device."),
		).toBeTruthy();
	});

	it("fails loud when a ciphered record arrives without a zk context", async () => {
		render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
			/>,
		);
		expect(
			await screen.findByText("This record could not be decrypted on this device."),
		).toBeTruthy();
		expect(mocks.decryptPatient).not.toHaveBeenCalled();
	});

	it("encrypts the draft and attaches grants on a ZK create", async () => {
		mocks.newPatientDek.mockResolvedValue({ dek, grants: [grant] });
		mocks.encryptPatientDraft.mockResolvedValue({
			name: "v1.name",
			birthDate: "v1.date",
			ciphered: true,
			active: true,
		});
		const save = vi.fn<Save>().mockResolvedValue({ ok: true, patient: { id: 9 } });
		const onSaved = vi.fn();
		const user = userEvent.setup();
		render(<PatientFormPage api={{ save }} onSaved={onSaved} locale="en" zk={zk} />);
		await fillRequired(user);
		await user.click(screen.getByRole("button", { name: "Register patient" }));
		await screen.findByDisplayValue("Ana Souza"); // settle
		expect(mocks.newPatientDek).toHaveBeenCalledWith(keyring, zkApi);
		expect(mocks.encryptPatientDraft).toHaveBeenCalledWith(
			dek,
			expect.objectContaining({ name: "Ana Souza" }),
		);
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ name: "v1.name", ciphered: true, grants: [grant] }),
		);
		expect(onSaved).toHaveBeenCalledWith(9);
	});

	it("reuses the record DEK on a ZK update", async () => {
		mocks.patientDek.mockResolvedValue(dek);
		mocks.encryptPatientDraft.mockResolvedValue({
			name: "v1.new",
			birthDate: "v1.date",
			ciphered: true,
			active: true,
		});
		const save = vi.fn<Save>().mockResolvedValue({ ok: true, patient: { id: 7 } });
		const user = userEvent.setup();
		render(
			<PatientFormPage
				patient={makePatient({ id: 7, birthDate: "1984" })}
				api={{ save }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(mocks.patientDek).toHaveBeenCalledWith(keyring, zkApi, 7);
		expect(mocks.newPatientDek).not.toHaveBeenCalled();
		expect(save).toHaveBeenCalledWith(
			expect.objectContaining({ name: "v1.new", grants: undefined }),
		);
	});

	it("refuses to save when this device cannot unwrap the record DEK", async () => {
		mocks.patientDek.mockResolvedValue(null);
		const save = vi.fn<Save>();
		const user = userEvent.setup();
		render(
			<PatientFormPage
				patient={makePatient({ id: 7, birthDate: "1984" })}
				api={{ save }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		await user.click(screen.getByRole("button", { name: "Save changes" }));
		expect(
			await screen.findByText("This record could not be decrypted on this device."),
		).toBeTruthy();
		expect(save).not.toHaveBeenCalled();
	});
});

describe("PatientFormPage — ZK unmount branches", () => {
	const zkApi: PatientZkApi = {
		devices: vi.fn(async () => []),
		dekEnvelopes: vi.fn(async () => ({})),
		grant: vi.fn(async () => ({ ok: true })),
	};
	const zk = { keyring: {} as unknown as KeyringService, api: zkApi };
	const ciphered = makePatient({ id: 7, name: "v1.YWFh.YmJi", birthDate: "v1.Y2Jk" });

	it("shows the localized failure when decrypt rejects", async () => {
		mocks.decryptPatient.mockRejectedValue(new Error("no key"));
		render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		expect(
			await screen.findByText("This record could not be decrypted on this device."),
		).toBeTruthy();
	});

	it("ignores a decrypt result arriving after unmount", async () => {
		let resolve: ((p: typeof ciphered | null) => void) | undefined;
		mocks.decryptPatient.mockImplementation(
			() => new Promise<typeof ciphered | null>((r) => (resolve = r)),
		);
		const { unmount } = render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		unmount();
		resolve?.(ciphered);
		await Promise.resolve();
		expect(mocks.decryptPatient).toHaveBeenCalledOnce();
	});

	it("ignores a decrypt rejection arriving after unmount", async () => {
		let reject: ((e: unknown) => void) | undefined;
		mocks.decryptPatient.mockImplementation(
			() => new Promise<typeof ciphered | null>((_r, j) => (reject = j)),
		);
		const { unmount } = render(
			<PatientFormPage
				patient={ciphered}
				api={{ save: vi.fn<Save>() }}
				onSaved={vi.fn()}
				locale="en"
				zk={zk}
			/>,
		);
		unmount();
		reject?.(new Error("gone"));
		await Promise.resolve();
		expect(mocks.decryptPatient).toHaveBeenCalledOnce();
	});
});
