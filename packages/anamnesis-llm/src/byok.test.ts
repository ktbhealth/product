import { describe, expect, it, vi } from "vitest";

import { HeuristicExtractor } from "@ktb/anamnesis";

import { makeByokExtractor } from "./byok.ts";

const anamnesisJson = async () =>
	JSON.stringify(await new HeuristicExtractor().extract("Paciente com dor de cabeça."));

const okResponse = (content: string) =>
	new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("makeByokExtractor (T-146)", () => {
	it("posts an OpenAI-compatible request with the clinic key", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(await anamnesisJson()));
		const extractor = makeByokExtractor(
			{ apiKey: "sk-1", model: "gpt-4o-mini", baseUrl: "https://llm.x/v1/" },
			fetchImpl,
		);
		const doc = await extractor.extract("Paciente com dor de cabeça.");
		expect(doc.queixa_principal.content).toBeTruthy();
		expect(extractor.name).toBe("byok");
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("https://llm.x/v1/chat/completions");
		expect((init?.headers as Record<string, string>).authorization).toBe("Bearer sk-1");
		const body = JSON.parse(init?.body as string);
		expect(body.model).toBe("gpt-4o-mini");
		expect(body.messages[1].content).toBe("Paciente com dor de cabeça.");
	});

	it("defaults to the OpenAI endpoint", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(await anamnesisJson()));
		await makeByokExtractor({ apiKey: "k", model: "m" }, fetchImpl).extract("t");
		expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.openai.com/v1/chat/completions");
	});

	it("throws on non-ok responses", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response("nope", { status: 429 }));
		await expect(
			makeByokExtractor({ apiKey: "k", model: "m" }, fetchImpl).extract("t"),
		).rejects.toThrow("429");
	});

	it("throws when the completion carries no content", async () => {
		const fetchImpl = vi.fn<typeof fetch>(
			async () => new Response(JSON.stringify({ choices: [] })),
		);
		await expect(
			makeByokExtractor({ apiKey: "k", model: "m" }, fetchImpl).extract("t"),
		).rejects.toThrow("no content");
	});

	it("throws on schema drift so the seam can fall back", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () =>
			okResponse(JSON.stringify({ not: "anamnesis" })),
		);
		await expect(
			makeByokExtractor({ apiKey: "k", model: "m" }, fetchImpl).extract("t"),
		).rejects.toThrow("invalid anamnesis");
	});
});
