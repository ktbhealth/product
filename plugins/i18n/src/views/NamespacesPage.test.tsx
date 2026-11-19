// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { LocaleInfo, NamespaceCoverage, NamespaceInfo } from "../contract.ts";
import type { NamespacesPageData } from "./NamespacesPage.tsx";
import { NamespacesPage } from "./NamespacesPage.tsx";

const locales: readonly LocaleInfo[] = [
	{ code: "en", endonym: "English", fallbacks: [], enabled: true },
	{ code: "pt-BR", endonym: "Português", fallbacks: ["en"], enabled: true },
	{ code: "fr", endonym: "Français", fallbacks: ["en"], enabled: false },
	// qps is pseudo-localized at slice time — it never gets a column,
	// even when enabled.
	{ code: "qps", endonym: "Pseudo", fallbacks: [], enabled: true },
];

const namespaces: readonly NamespaceInfo[] = [
	{
		namespace: "patients.messages",
		pluginId: "patients.services",
		defaultLocale: "en",
		messageCount: 10,
	},
	// Manifest-only row: no coverage entry, so keyCount falls back to
	// messageCount and every locale reads 0 translated.
	{ namespace: "manifest.only", pluginId: "", defaultLocale: "pt-BR", messageCount: 5 },
	// Zero-key namespace: coverage cells render "—".
	{ namespace: "empty.ns", pluginId: "empty.plugin", defaultLocale: "en", messageCount: 0 },
];

const coverage: readonly NamespaceCoverage[] = [
	{
		namespace: "patients.messages",
		pluginId: "patients.services",
		defaultLocale: "en",
		keyCount: 4,
		translated: { en: 4, "pt-BR": 3 },
		manifestHash: "0123abcd",
		manifestDrift: "no",
	},
	// Coverage-only row: no manifest entry.
	{
		namespace: "coverage.only",
		pluginId: "reports.plugin",
		defaultLocale: "en",
		keyCount: 2,
		translated: { en: 2 },
		manifestHash: "",
		manifestDrift: "unrecorded",
	},
];

const data: NamespacesPageData = { namespaces, coverage, locales };

afterEach(cleanup);

describe("NamespacesPage", () => {
	it("renders the union of namespaces and coverage, sorted by name", async () => {
		render(<NamespacesPage data={data} />);
		expect(await screen.findByText("patients.messages")).toBeTruthy();
		// Coverage-only and manifest-only rows both appear.
		expect(screen.getByText("coverage.only")).toBeTruthy();
		expect(screen.getByText("manifest.only")).toBeTruthy();
		expect(screen.getByText("empty.ns")).toBeTruthy();
		// Plugin ids come from whichever side has them; a missing one is "—".
		expect(screen.getByText("patients.services")).toBeTruthy();
		expect(screen.getByText("reports.plugin")).toBeTruthy();
		expect(screen.getByText("empty.plugin")).toBeTruthy();
		const manifestRow = screen.getByText("manifest.only").closest("tr");
		expect(manifestRow).not.toBeNull();
		expect(within(manifestRow as HTMLElement).getByText("—")).toBeTruthy();
	});

	it("renders per-locale coverage columns for enabled non-qps locales only", async () => {
		render(<NamespacesPage data={data} />);
		await screen.findByText("patients.messages");
		expect(screen.getByText("English")).toBeTruthy();
		expect(screen.getByText("Português")).toBeTruthy();
		expect(screen.queryByText("Français")).toBeNull();
		expect(screen.queryByText("Pseudo")).toBeNull();

		const patientsRow = screen.getByText("patients.messages").closest("tr") as HTMLElement;
		// Full coverage has no missing suffix; partial coverage does.
		expect(within(patientsRow).getByText("4/4 · 100%")).toBeTruthy();
		expect(within(patientsRow).getByText("3/4 · 75%")).toBeTruthy();
		expect(within(patientsRow).getByText("· 1 missing")).toBeTruthy();

		const coverageRow = screen.getByText("coverage.only").closest("tr") as HTMLElement;
		expect(within(coverageRow).getByText("2/2 · 100%")).toBeTruthy();
		expect(within(coverageRow).getByText("0/2 · 0%")).toBeTruthy();
		expect(within(coverageRow).getByText("· 2 missing")).toBeTruthy();

		// Manifest-only row: messageCount keys, nothing translated.
		const manifestRow = screen.getByText("manifest.only").closest("tr") as HTMLElement;
		expect(within(manifestRow).getAllByText("0/5 · 0%")).toHaveLength(2);
		expect(within(manifestRow).getAllByText("· 5 missing")).toHaveLength(2);
	});

	it("renders dashes for namespaces with zero keys", async () => {
		render(<NamespacesPage data={data} />);
		await screen.findByText("empty.ns");
		const emptyRow = screen.getByText("empty.ns").closest("tr") as HTMLElement;
		expect(within(emptyRow).getAllByText("—")).toHaveLength(2);
	});

	it("shows the summary line with namespace, key and incomplete-locale counts", async () => {
		render(<NamespacesPage data={data} />);
		// 4 namespaces, 11 keys total (2 + 0 + 5 + 4); en and pt-BR are
		// both below full coverage (manifest.only is missing everywhere,
		// patients.messages is missing 1 pt-BR key).
		expect(
			await screen.findByText("4 namespaces · 11 keys · 2 locales below full coverage"),
		).toBeTruthy();
	});

	it("shows a contract-drift badge only on drifted rows and counts them in the summary", async () => {
		const driftedCoverage: readonly NamespaceCoverage[] = [
			{
				namespace: "patients.messages",
				pluginId: "patients.services",
				defaultLocale: "en",
				keyCount: 4,
				translated: { en: 4, "pt-BR": 3 },
				manifestHash: "ffff0000",
				manifestDrift: "yes",
			},
			coverage[1],
		];
		render(<NamespacesPage data={{ namespaces, coverage: driftedCoverage, locales }} />);
		await screen.findByText("patients.messages");
		const patientsRow = screen.getByText("patients.messages").closest("tr") as HTMLElement;
		expect(within(patientsRow).getByText("contract changed")).toBeTruthy();
		// coverage.only is "unrecorded" — no badge.
		const orphanRow = screen.getByText("coverage.only").closest("tr") as HTMLElement;
		expect(within(orphanRow).queryByText("contract changed")).toBeNull();
		expect(
			await screen.findByText(
				"4 namespaces · 11 keys · 2 locales below full coverage · 1 namespace with contract drift",
			),
		).toBeTruthy();
	});

	it("shows an empty state with no namespaces", async () => {
		render(<NamespacesPage data={{ namespaces: [], coverage: [], locales: [] }} />);
		expect(await screen.findByText("No namespaces registered.")).toBeTruthy();
	});
});
