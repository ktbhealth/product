import { describe, expect, it } from "vitest";

import {
	ANAMNESIS,
	FULL_PATIENT,
	makeConsultation,
	makeExport,
	makePatientRecord,
	sequentialUuid,
} from "./testing.ts";

describe("makePatientRecord", () => {
	it("builds a name-only record with every other field empty", () => {
		expect(makePatientRecord()).toEqual({
			id: 1,
			active: true,
			name: "Maria Silva",
			socialName: null,
			gender: null,
			birthDate: null,
			cpf: null,
			cns: null,
			passport: null,
			phone: null,
			email: null,
			preferredLanguage: null,
			addressLine: null,
			addressNumber: null,
			addressComplement: null,
			district: null,
			city: null,
			state: null,
			postalCode: null,
			country: null,
			motherName: null,
			maritalStatus: null,
			raceColor: null,
			nationality: null,
			emergencyContactName: null,
			emergencyContactRelationship: null,
			emergencyContactPhone: null,
			createdAt: new Date("2026-11-01T10:00:00Z"),
			updatedAt: null,
		});
	});

	it("lets callers override any field", () => {
		const record = makePatientRecord({ id: 42, name: "João Souza", cpf: "11144477735" });
		expect(record.id).toBe(42);
		expect(record.name).toBe("João Souza");
		expect(record.cpf).toBe("11144477735");
		expect(record.active).toBe(true);
	});
});

describe("FULL_PATIENT", () => {
	it("fills every BR Core field", () => {
		expect(FULL_PATIENT).toEqual({
			id: 7,
			active: true,
			name: "Maria Aparecida Silva",
			socialName: "Cida",
			gender: "female",
			birthDate: "1984-03-05",
			cpf: "52998224725",
			cns: "100000000000007",
			passport: "FX123456",
			phone: "+55 81 98765-4321",
			email: "cida@example.com",
			preferredLanguage: "pt-BR",
			addressLine: "Rua da Aurora",
			addressNumber: "100",
			addressComplement: "apto 12",
			district: "Boa Vista",
			city: "Recife",
			state: "PE",
			postalCode: "50050000",
			country: "BR",
			motherName: "Josefa Silva",
			maritalStatus: "M",
			raceColor: "03",
			nationality: "BR",
			emergencyContactName: "Pedro Silva",
			emergencyContactRelationship: "filho",
			emergencyContactPhone: "81 3333-4444",
			createdAt: new Date("2026-11-01T10:00:00Z"),
			updatedAt: new Date("2026-11-02T10:00:00Z"),
		});
	});
});

describe("ANAMNESIS", () => {
	const expectedEvidence = ["Paciente relata dor de cabeça há três dias."];

	it("fills every clinical section with content, confidence and evidence", () => {
		expect(ANAMNESIS).toEqual({
			queixa_principal: {
				content: "Cefaleia há 3 dias",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			hda: {
				content: "Dor frontal <pulsátil> & piora à tarde.\r\nSem febre.",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			antecedentes: {
				content: "Hipertensão arterial",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			alergias: {
				content: "Nega alergias",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			medicamentos_em_uso: {
				content: "Losartana 50 mg",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			exame_fisico: {
				content: "PA 130x85 mmHg",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			hipoteses: {
				content: "Cefaleia tensional?",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			conduta: {
				content: "Analgesia e retorno em 7 dias",
				confidence: "alta",
				evidence: expectedEvidence,
			},
			historico: {
				content: "1 consulta anterior",
				confidence: "alta",
				evidence: expectedEvidence,
			},
		});
	});
});

describe("makeConsultation", () => {
	it("builds a finished browser consultation with the shared anamnesis", () => {
		expect(makeConsultation()).toEqual({
			id: 10,
			createdAt: new Date("2026-11-05T14:00:00Z"),
			source: "browser",
			status: "done",
			consentAt: new Date("2026-11-05T14:00:00Z"),
			transcript: "Paciente relata dor de cabeça há três dias. Sem febre. Ação.",
			anamnesis: ANAMNESIS,
			engine: "anthropic",
		});
	});

	it("lets callers override any field", () => {
		const consultation = makeConsultation({ id: 99, status: "live", anamnesis: null });
		expect(consultation.id).toBe(99);
		expect(consultation.status).toBe("live");
		expect(consultation.anamnesis).toBeNull();
	});
});

describe("makeExport", () => {
	it("bundles the full patient, one consultation and the practitioner", () => {
		const input = makeExport();
		expect(input.patient).toBe(FULL_PATIENT);
		expect(input.consultations).toHaveLength(1);
		expect(input.consultations[0]).toEqual(makeConsultation());
		expect(input.practitioner).toEqual({
			id: "u1",
			name: "Dra. Ana Souza",
			email: "ana@example.com",
		});
		expect(input.exportedAt).toEqual(new Date("2026-11-08T12:00:00Z"));
	});

	it("lets callers override any field", () => {
		const input = makeExport({
			consultations: [],
			practitioner: { id: "u2", name: "Dr. B", email: null },
		});
		expect(input.consultations).toEqual([]);
		expect(input.practitioner).toEqual({ id: "u2", name: "Dr. B", email: null });
	});
});

describe("sequentialUuid", () => {
	it("returns deterministic RFC 4122-shaped ids", () => {
		const next = sequentialUuid();
		expect(next()).toBe("00000000-0000-4000-8000-000000000001");
		expect(next()).toBe("00000000-0000-4000-8000-000000000002");
		expect(next()).toBe("00000000-0000-4000-8000-000000000003");
	});

	it("keeps counting past single digits", () => {
		const next = sequentialUuid();
		for (let i = 0; i < 9; i++) next();
		expect(next()).toBe("00000000-0000-4000-8000-000000000010");
	});
});
