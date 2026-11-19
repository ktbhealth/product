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
		expect(init?.method).toBe("POST");
		const headers = init?.headers as Record<string, string>;
		expect(headers.authorization).toBe("Bearer sk-1");
		expect(headers["content-type"]).toBe("application/json");
		const body = JSON.parse(init?.body as string);
		expect(body.model).toBe("gpt-4o-mini");
		expect(body.response_format).toEqual({ type: "json_object" });
		expect(body.messages).toHaveLength(2);
		expect(body.messages[0]).toEqual({
			role: "system",
			content: expect.stringContaining("clinical documentation assistant"),
		});
		expect(body.messages[1]).toEqual({
			role: "user",
			content: "Paciente com dor de cabeça.",
		});
	});

	it("strips every trailing slash from a custom base URL", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => okResponse(await anamnesisJson()));
		await makeByokExtractor(
			{ apiKey: "k", model: "m", baseUrl: "https://llm.x/v1//" },
			fetchImpl,
		).extract("t");
		expect(fetchImpl.mock.calls[0]![0]).toBe("https://llm.x/v1/chat/completions");
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
		for (const payload of [{ choices: [] }, {}, { choices: [{}] }]) {
			const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
			await expect(
				makeByokExtractor({ apiKey: "k", model: "m" }, fetchImpl).extract("t"),
			).rejects.toThrow("no content");
		}
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
