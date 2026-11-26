import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

import type { Anamnesis, AnamnesisSectionKey } from "@ktb/anamnesis";
import { HISTORY_SECTION_LABEL, SECTION_LABELS } from "@ktb/anamnesis";

export interface AnamnesisPdfInput {
	consultationId: number;
	createdAt: Date;
	patientName: string | null;
	/** Record demographics/identifiers line, e.g. "Female · 42 years · CPF 529.982.247-25". */
	patientDetails?: string | null;
	doctorName: string | null;
	consentAt: Date | null;
	anamnesis: Anamnesis;
}

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;
const CONTENT_W = A4[0] - MARGIN * 2;
const INK = rgb(0.07, 0.07, 0.07);
const BODY = rgb(0.13, 0.13, 0.13);
const GRAY = rgb(0.33, 0.33, 0.33);
const LINE = rgb(0.87, 0.87, 0.87);
const FOOTER = rgb(0.6, 0.6, 0.6);

const fmt = (d: Date) => d.toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" });

type PdfFont = Awaited<ReturnType<PDFDocument["embedFont"]>>;

const wrap = (text: string, font: PdfFont, size: number, width: number): string[] => {
	const lines: string[] = [];
	for (const para of text.split("\n")) {
		if (para.trim() === "") {
			lines.push("");
			continue;
		}
		let line = "";
		for (const word of para.split(/\s+/)) {
			const candidate = line === "" ? word : `${line} ${word}`;
			if (font.widthOfTextAtSize(candidate, size) <= width) {
				line = candidate;
			} else {
				if (line !== "") lines.push(line);
				line = word;
			}
		}
		if (line !== "") lines.push(line);
	}
	return lines;
};

/** Renders the reviewed anamnesis as an A4 PDF (standard fonts). */
export async function renderAnamnesisPdf(input: AnamnesisPdfInput): Promise<Buffer> {
	const doc = await PDFDocument.create();
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const regular = await doc.embedFont(StandardFonts.Helvetica);

	let page = doc.addPage(A4);
	let y = A4[1] - MARGIN;
	const newPage = () => {
		page = doc.addPage(A4);
		y = A4[1] - MARGIN;
	};
	const ensure = (needed: number) => {
		if (y - needed < MARGIN) newPage();
	};
	const drawWrapped = (
		text: string,
		opts: { size: number; font: PdfFont; color: typeof INK; gap: number },
	) => {
		for (const line of wrap(text, opts.font, opts.size, CONTENT_W)) {
			ensure(opts.size * 1.3);
			if (line !== "") {
				page.drawText(line, { x: MARGIN, y, size: opts.size, font: opts.font, color: opts.color });
			}
			y -= opts.size * opts.gap;
		}
	};
	const meta = (text: string) =>
		drawWrapped(text, { size: 9.5, font: regular, color: GRAY, gap: 1.2 });

	// ---- header ----
	page.drawText("Anamnesis", { x: MARGIN, y, size: 20, font: bold, color: INK });
	y -= 30;
	meta(`Consultation #${input.consultationId} · ${fmt(input.createdAt)}`);
	if (input.patientName) meta(`Patient: ${input.patientName}`);
	if (input.patientDetails) meta(input.patientDetails);
	if (input.doctorName) meta(`Physician: ${input.doctorName}`);
	meta(
		input.consentAt
			? `Patient consent declared on ${fmt(input.consentAt)}`
			: "Patient consent: not recorded",
	);
	y -= 6;
	page.drawLine({
		start: { x: MARGIN, y },
		end: { x: A4[0] - MARGIN, y },
		thickness: 1,
		color: LINE,
	});
	y -= 14;

	// ---- sections ----
	const historico = input.anamnesis.historico;
	const blocks: { label: string; content: string }[] = [
		...(Object.keys(SECTION_LABELS) as AnamnesisSectionKey[]).map((key) => ({
			label: SECTION_LABELS[key],
			content: input.anamnesis[key]?.content?.trim() || "Not reported",
		})),
		...(historico
			? [{ label: HISTORY_SECTION_LABEL, content: historico.content.trim() || "Not reported" }]
			: []),
	];
	for (const block of blocks) {
		ensure(60);
		page.drawText(block.label.toUpperCase(), {
			x: MARGIN,
			y,
			size: 11,
			font: bold,
			color: INK,
		});
		y -= 15;
		drawWrapped(block.content, { size: 10.5, font: regular, color: BODY, gap: 1.2 });
		y -= 8;
	}

	// ---- signature ----
	ensure(70);
	y -= 16;
	const sy = y;
	page.drawLine({
		start: { x: MARGIN, y: sy },
		end: { x: MARGIN + 220, y: sy },
		thickness: 1,
		color: rgb(0.53, 0.53, 0.53),
	});
	page.drawText(input.doctorName ?? "Responsible physician", {
		x: MARGIN,
		y: sy - 14,
		size: 9,
		font: regular,
		color: GRAY,
	});

	// ---- footer on every page ----
	const pages = doc.getPages();
	const footer =
		"AI-structured draft generated from the transcript, reviewed and validated by the responsible physician.";
	pages.forEach((p, i) => {
		const label = `${i + 1}/${pages.length}`;
		p.drawText(footer, { x: MARGIN, y: 28, size: 8, font: regular, color: FOOTER });
		p.drawText(label, {
			x: A4[0] - MARGIN - regular.widthOfTextAtSize(label, 8),
			y: 28,
			size: 8,
			font: regular,
			color: FOOTER,
		});
	});

	return Buffer.from(await doc.save({ useObjectStreams: false }));
}
