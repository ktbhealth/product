// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FnMock = (arg: { data: unknown }) => Promise<unknown>;
const fns = vi.hoisted(() => ({
	i18nMissingKeysFn: vi.fn<FnMock>(async () => ({ ok: true, keys: [] as string[] })),
}));
vi.mock("../fns.ts", () => fns);

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

/** Namespace names in rendered row order (first cell of each body row). */
const renderedNamespaces = (): string[] =>
	[...document.querySelectorAll("tbody tr")].map(
		(tr) => tr.querySelector("td")?.textContent?.trim() ?? "",
	);

afterEach(cleanup);

beforeEach(() => {
	fns.i18nMissingKeysFn.mockReset();
	fns.i18nMissingKeysFn.mockResolvedValue({ ok: true, keys: [] });
});

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

	it("renders progress bars and heatmap tints on coverage cells", async () => {
		render(<NamespacesPage data={data} />);
		await screen.findByText("patients.messages");
		const patientsRow = screen.getByText("patients.messages").closest("tr") as HTMLElement;
		// The kit cell has no className hook — the tint lives on a wrapper
		// div inside the td that bleeds into the cell's padding.
		const partialTint = within(patientsRow).getByText("3/4 · 75%").closest("div") as HTMLElement;
		// 75% → light warning tint; the bar fills 75% and is warning-colored.
		expect(partialTint.className).toContain("bg-warning/5");
		const bar = partialTint.querySelector("span[aria-hidden='true'] span") as HTMLElement;
		expect(bar.style.width).toBe("75%");
		expect(bar.className).toContain("bg-warning");
		const fullTint = within(patientsRow).getByText("4/4 · 100%").closest("div") as HTMLElement;
		expect(fullTint.className).not.toContain("bg-warning");
		// Under 50% gets the stronger tint.
		const coverageRow = screen.getByText("coverage.only").closest("tr") as HTMLElement;
		const emptyTint = within(coverageRow).getByText("0/2 · 0%").closest("div") as HTMLElement;
		expect(emptyTint.className).toContain("bg-warning/15");
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

	describe("missing-keys drill-down", () => {
		it("opens a dialog on a coverage-cell click, fetches and lists missing keys", async () => {
			const user = userEvent.setup();
			fns.i18nMissingKeysFn.mockResolvedValue({ ok: true, keys: ["title", "subtitle"] });
			render(<NamespacesPage data={data} />);
			await screen.findByText("patients.messages");
			const row = screen.getByText("patients.messages").closest("tr") as HTMLElement;
			await user.click(
				within(row).getByRole("button", {
					name: "Show 1 missing patients.messages keys for Português",
				}),
			);
			expect(fns.i18nMissingKeysFn).toHaveBeenCalledWith({
				data: { namespace: "patients.messages", locale: "pt-BR" },
			});
			const dialog = await screen.findByRole("dialog");
			expect(within(dialog).getByText("patients.messages · pt-BR")).toBeTruthy();
			expect(await within(dialog).findByText("title")).toBeTruthy();
			expect(within(dialog).getByText("subtitle")).toBeTruthy();
		});

		it("keeps fully-covered and zero-key cells non-interactive", async () => {
			render(<NamespacesPage data={data} />);
			await screen.findByText("patients.messages");
			const patientsRow = screen.getByText("patients.messages").closest("tr") as HTMLElement;
			expect(
				within(patientsRow).queryByRole("button", {
					name: /keys for English/,
				}),
			).toBeNull();
			const emptyRow = screen.getByText("empty.ns").closest("tr") as HTMLElement;
			expect(within(emptyRow).queryByRole("button")).toBeNull();
			expect(fns.i18nMissingKeysFn).not.toHaveBeenCalled();
		});

		it("surfaces the server error inside the dialog", async () => {
			const user = userEvent.setup();
			fns.i18nMissingKeysFn.mockResolvedValue({ ok: false, error: "nope" });
			render(<NamespacesPage data={data} />);
			await screen.findByText("coverage.only");
			const row = screen.getByText("coverage.only").closest("tr") as HTMLElement;
			await user.click(
				within(row).getAllByRole("button", { name: /missing coverage\.only keys/ })[0]!,
			);
			const dialog = await screen.findByRole("dialog");
			expect(await within(dialog).findByText("nope")).toBeTruthy();
		});

		it("shows the denied fallback when the result carries no error", async () => {
			const user = userEvent.setup();
			fns.i18nMissingKeysFn.mockResolvedValue({ ok: false });
			render(<NamespacesPage data={data} />);
			await screen.findByText("coverage.only");
			const row = screen.getByText("coverage.only").closest("tr") as HTMLElement;
			await user.click(
				within(row).getAllByRole("button", { name: /missing coverage\.only keys/ })[0]!,
			);
			const dialog = await screen.findByRole("dialog");
			expect(await within(dialog).findByText("denied")).toBeTruthy();
		});

		it("shows an empty state when the server reports no missing keys", async () => {
			const user = userEvent.setup();
			render(<NamespacesPage data={data} />);
			await screen.findByText("coverage.only");
			const row = screen.getByText("coverage.only").closest("tr") as HTMLElement;
			await user.click(
				within(row).getAllByRole("button", { name: /missing coverage\.only keys/ })[0]!,
			);
			const dialog = await screen.findByRole("dialog");
			expect(await within(dialog).findByText("All keys translated.")).toBeTruthy();
		});
	});

	describe("toolbar", () => {
		it("filters rows by namespace substring, case-insensitive", async () => {
			const user = userEvent.setup();
			render(<NamespacesPage data={data} />);
			await screen.findByText("patients.messages");
			await user.type(screen.getByPlaceholderText("Filter namespaces"), "PATIENTS");
			expect(screen.getByText("patients.messages")).toBeTruthy();
			expect(screen.queryByText("manifest.only")).toBeNull();
			expect(screen.queryByText("coverage.only")).toBeNull();
			expect(screen.queryByText("empty.ns")).toBeNull();
		});

		it("hides fully-covered namespaces with the below-100% toggle", async () => {
			const user = userEvent.setup();
			render(<NamespacesPage data={data} />);
			await screen.findByText("empty.ns");
			await user.click(screen.getByRole("checkbox", { name: "Below 100% only" }));
			// empty.ns has zero keys — nothing to translate, so it is
			// treated as complete and hidden.
			expect(screen.queryByText("empty.ns")).toBeNull();
			expect(screen.getByText("patients.messages")).toBeTruthy();
			expect(screen.getByText("manifest.only")).toBeTruthy();
			expect(screen.getByText("coverage.only")).toBeTruthy();
		});

		it("reorders rows by most keys", async () => {
			const user = userEvent.setup();
			render(<NamespacesPage data={data} />);
			await screen.findByText("patients.messages");
			expect(renderedNamespaces()).toEqual([
				"coverage.only",
				"empty.ns",
				"manifest.only",
				"patients.messages",
			]);
			await user.click(screen.getByRole("combobox"));
			await user.click(await screen.findByRole("option", { name: "Sort: most keys" }));
			expect(renderedNamespaces()).toEqual([
				"manifest.only",
				"patients.messages",
				"coverage.only",
				"empty.ns",
			]);
		});

		it("reorders rows by worst coverage", async () => {
			const user = userEvent.setup();
			render(<NamespacesPage data={data} />);
			await screen.findByText("patients.messages");
			await user.click(screen.getByRole("combobox"));
			await user.click(await screen.findByRole("option", { name: "Sort: worst coverage" }));
			// coverage.only and manifest.only both hit 0% somewhere;
			// name breaks the tie. empty.ns (no keys) sorts last.
			expect(renderedNamespaces()).toEqual([
				"coverage.only",
				"manifest.only",
				"patients.messages",
				"empty.ns",
			]);
		});
	});
});
