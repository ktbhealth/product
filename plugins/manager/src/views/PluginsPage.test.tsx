// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { definePlugin, type Plugin, type PluginId } from "@ktb/kernel";
import { Schema } from "effect";

const invalidate = vi.hoisted(() => vi.fn(async () => {}));
const fns = vi.hoisted(() => ({
	setPluginEnabledFn: vi.fn(),
	setPluginConfigFn: vi.fn(),
	getPluginConfigFn: vi.fn(),
	getMetricsFn: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
	useRouter: () => ({ invalidate }),
}));
vi.mock("../fns.ts", () => fns);

import { PluginsPage, type PluginStateInfo } from "./PluginsPage.tsx";

declare module "@ktb/kernel" {
	interface PluginRegistry {
		"v.base": true;
		"v.child": true;
		"v.other": true;
		"v.config": true;
		"v.rich": true;
		"v.sys": true;
		"v.confignodesc": true;
	}
}

const dep = (id: string, deps: readonly string[] = []) =>
	definePlugin({ id, requiredDeps: deps as unknown as readonly PluginId[] });

const configSchemaDocument = Schema.toJsonSchemaDocument(
	Schema.Struct({
		title: Schema.String.annotate({ title: "Title" }),
		retries: Schema.optionalKey(Schema.Finite).annotate({
			title: "Retries",
		}),
		verbose: Schema.optionalKey(Schema.Boolean).annotate({
			title: "Verbose",
			default: false,
		}),
		mode: Schema.optionalKey(Schema.Literals(["a", "b"])).annotate({
			title: "Mode",
			default: "a",
		}),
	}),
);

const plugins: readonly Plugin[] = [
	dep("v.base"),
	dep("v.child", ["v.base"]),
	dep("v.other"),
	definePlugin({
		id: "v.config",
		meta: {
			name: "Configurable",
			description: "Has a config schema",
			config: { schema: configSchemaDocument },
		},
	}),
	definePlugin({
		id: "v.confignodesc",
		meta: {
			name: "BareConfig",
			config: { schema: configSchemaDocument },
		},
	}),
];

const statesOf = (entries: Record<string, { enabled: boolean; config?: unknown }>) =>
	new Map<string, PluginStateInfo>(
		Object.entries(entries).map(([pluginId, e]) => [
			pluginId,
			{ pluginId, enabled: e.enabled, config: e.config ?? null },
		]),
	);

const allEnabled = () =>
	statesOf({
		"v.base": { enabled: true },
		"v.child": { enabled: true },
		"v.other": { enabled: true },
		"v.config": { enabled: true, config: { title: "T", retries: 3, verbose: false, mode: "a" } },
	});

beforeEach(() => {
	vi.clearAllMocks();
	fns.setPluginEnabledFn.mockResolvedValue(true);
	fns.setPluginConfigFn.mockResolvedValue(true);
	fns.getPluginConfigFn.mockResolvedValue({ title: "T" });
	fns.getMetricsFn.mockResolvedValue({ serverFns: [], sessionContexts: [] });
});

afterEach(cleanup);

/** Open the generated config dialog for the "Configurable" fixture row. */
const openConfig = async (user: ReturnType<typeof userEvent.setup>) => {
	await user.click(screen.getByRole("button", { name: "Actions for Configurable" }));
	await user.click(await screen.findByRole("menuitem", { name: "Configure" }));
};

describe("PluginsPage", () => {
	it("renders every plugin with name, kinds and enabled status", () => {
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(screen.getByText("Plugins")).toBeTruthy();
		// The id renders twice per row (name fallback + muted id line).
		expect(screen.getAllByText("v.base").length).toBeGreaterThan(0);
		expect(screen.getByText("Configurable")).toBeTruthy();
		expect(screen.getAllByText("Enabled").length).toBe(plugins.length);
	});

	it("locks system plugins: disabled toggle, System badge and hint", async () => {
		const user = userEvent.setup();
		const sys = definePlugin({ id: "v.sys", system: true });
		const states = statesOf({ "v.sys": { enabled: true } });
		render(<PluginsPage plugins={[sys]} states={states} locale="en" />);
		expect(screen.getByText("System")).toBeTruthy();
		expect(screen.getByText(/always enabled and cannot be disabled/)).toBeTruthy();
		const toggle = screen.getByRole("switch");
		// Base UI marks disabled controls with data-disabled (no native
		// `disabled` property on the rendered element).
		expect(
			toggle.hasAttribute("data-disabled") || toggle.getAttribute("aria-disabled") === "true",
		).toBe(true);
		await user.click(toggle);
		expect(fns.setPluginEnabledFn).not.toHaveBeenCalled();
	});

	it("shows disabled state from the loader map", () => {
		const states = allEnabled();
		states.set("v.other", { pluginId: "v.other", enabled: false, config: null });
		render(<PluginsPage plugins={plugins} states={states} locale="en" />);
		expect(screen.getByText("Disabled")).toBeTruthy();
	});

	it("disables a plugin with no dependents directly", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		// v.other has no dependents → single-id disable, no dialog.
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.other")]);
		expect(fns.setPluginEnabledFn).toHaveBeenCalledWith({
			data: { ids: ["v.other"], enabled: false },
		});
		expect(invalidate).toHaveBeenCalled();
	});

	it("confirms the cascade when dependents exist", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.base")]);
		// Dialog lists the dependents; nothing sent yet.
		expect(fns.setPluginEnabledFn).not.toHaveBeenCalled();
		expect(screen.getByText(/This also disables/)).toBeTruthy();
		await user.click(screen.getByText("Disable all"));
		expect(fns.setPluginEnabledFn).toHaveBeenCalledWith({
			data: { ids: ["v.base", "v.child"], enabled: false },
		});
	});

	it("skips the cascade dialog when cascadeConfirm is false", async () => {
		const user = userEvent.setup();
		render(
			<PluginsPage plugins={plugins} states={allEnabled()} locale="en" cascadeConfirm={false} />,
		);
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.base")]);
		expect(fns.setPluginEnabledFn).toHaveBeenCalledWith({
			data: { ids: ["v.base", "v.child"], enabled: false },
		});
	});

	it("refuses to enable a plugin whose required dep is disabled", async () => {
		const user = userEvent.setup();
		const states = allEnabled();
		states.set("v.base", { pluginId: "v.base", enabled: false, config: null });
		states.set("v.child", { pluginId: "v.child", enabled: false, config: null });
		render(<PluginsPage plugins={plugins} states={states} locale="en" />);
		expect(screen.getByText(/Requires v.base to be enabled first/)).toBeTruthy();
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.child")]);
		expect(fns.setPluginEnabledFn).not.toHaveBeenCalled();
	});

	it("enables a plugin when its deps are on", async () => {
		const user = userEvent.setup();
		const states = allEnabled();
		states.set("v.other", { pluginId: "v.other", enabled: false, config: null });
		render(<PluginsPage plugins={plugins} states={states} locale="en" />);
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.other")]);
		expect(fns.setPluginEnabledFn).toHaveBeenCalledWith({
			data: { ids: ["v.other"], enabled: true },
		});
	});

	it("renders the generated config form in a dialog and saves it", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		// Fields stay hidden until the row action opens the dialog.
		expect(screen.queryByRole("textbox", { name: /^Title/ })).toBeNull();
		await openConfig(user);
		expect(screen.getByText(/^Title/)).toBeTruthy();
		expect(screen.getByText("Retries")).toBeTruthy();
		expect(screen.getByText("Verbose")).toBeTruthy();
		expect(screen.getByText("Mode")).toBeTruthy();
		await user.click(screen.getByText("Save"));
		expect(fns.getPluginConfigFn).toHaveBeenCalledWith({ data: "v.config" });
		expect(fns.setPluginConfigFn).toHaveBeenCalledWith({
			data: {
				pluginId: "v.config",
				config: { title: "T", retries: 3, verbose: false, mode: "a" },
			},
		});
		expect(await screen.findByText("Saved.")).toBeTruthy();
	});

	it("resyncs config fields when the server config changes (post-invalidate)", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />,
		);
		await openConfig(user);
		const title = screen.getByRole("textbox", { name: /^Title/ });
		await user.clear(title);
		await user.type(title, "edited");
		// router.invalidate() → loader returns fresh entries with a new
		// config object: the form must pick up the server values again.
		const states2 = allEnabled();
		states2.set("v.config", {
			pluginId: "v.config",
			enabled: true,
			config: { title: "New", retries: 5, verbose: true, mode: "b" },
		});
		rerender(<PluginsPage plugins={plugins} states={states2} locale="en" />);
		expect(screen.getByDisplayValue("New")).toBeTruthy();
		expect(screen.getByDisplayValue("5")).toBeTruthy();
	});

	it("keeps in-progress edits when invalidate returns identical config", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />,
		);
		await openConfig(user);
		const title = screen.getByRole("textbox", { name: /^Title/ });
		await user.clear(title);
		await user.type(title, "edited");
		// New Map/object identities but identical serialized config —
		// unrelated invalidations must not clobber the draft.
		rerender(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(screen.getByDisplayValue("edited")).toBeTruthy();
	});

	it("does not coerce a cleared number field to 0 — the key stays unset", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await openConfig(user);
		const retries = screen.getByRole("spinbutton", { name: /^Retries/ });
		expect((retries as HTMLInputElement).value).toBe("3");
		await user.clear(retries);
		await user.click(screen.getByText("Save"));
		expect(fns.setPluginConfigFn).toHaveBeenCalledWith({
			data: {
				pluginId: "v.config",
				config: { title: "T", verbose: false, mode: "a" },
			},
		});
	});

	it("changes an enum config field through the Select and saves it", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await openConfig(user);
		// The enum field renders the styled Select: a button trigger that
		// opens a listbox of options.
		await user.click(screen.getByRole("combobox", { name: "Mode" }));
		await user.click(await screen.findByRole("option", { name: "b" }));
		await user.click(screen.getByText("Save"));
		expect(fns.setPluginConfigFn).toHaveBeenCalledWith({
			data: {
				pluginId: "v.config",
				config: { title: "T", retries: 3, verbose: false, mode: "b" },
			},
		});
	});

	it("surfaces a failure message when the enable write is refused or throws", async () => {
		const user = userEvent.setup();
		const toggle = async () => {
			const switches = screen.getAllByRole("switch");
			await user.click(switches[plugins.findIndex((p) => p.id === "v.other")]);
		};
		// Refused write (ok === false) → failed banner, no invalidate.
		fns.setPluginEnabledFn.mockResolvedValueOnce(false);
		const first = render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await toggle();
		expect(await screen.findByText("Could not save the configuration.")).toBeTruthy();
		expect(invalidate).not.toHaveBeenCalled();
		first.unmount();
		// Thrown write → same banner.
		fns.setPluginEnabledFn.mockRejectedValueOnce(new Error("boom"));
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await toggle();
		expect(await screen.findByText("Could not save the configuration.")).toBeTruthy();
	});

	it("names cascade targets by id when they leave the registry mid-dialog", async () => {
		const user = userEvent.setup();
		const { rerender } = render(
			<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />,
		);
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.base")]);
		expect(screen.getByText(/This also disables/)).toBeTruthy();
		// The dialog stays open while the plugin list shrinks — a pending
		// id absent from `plugins` falls back to its raw id in the body.
		rerender(
			<PluginsPage
				plugins={plugins.filter((p) => p.id !== "v.child")}
				states={allEnabled()}
				locale="en"
			/>,
		);
		expect(screen.getByText(/v\.child, which depend/)).toBeTruthy();
	});

	it("closes the cascade dialog on cancel without writing", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		const switches = screen.getAllByRole("switch");
		await user.click(switches[plugins.findIndex((p) => p.id === "v.base")]);
		expect(screen.getByText(/This also disables/)).toBeTruthy();
		await user.click(screen.getByText("Cancel"));
		await waitFor(() => expect(screen.queryByText(/This also disables/)).toBeNull());
		expect(fns.setPluginEnabledFn).not.toHaveBeenCalled();
	});

	it("toggles a boolean config field through its Switch and saves it", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await openConfig(user);
		// The config form's boolean field is the last switch on the page
		// (after the four row toggles; the dialog portals to body end).
		const switches = screen.getAllByRole("switch");
		await user.click(switches[switches.length - 1]!);
		await user.click(screen.getByText("Save"));
		expect(fns.setPluginConfigFn).toHaveBeenCalledWith({
			data: {
				pluginId: "v.config",
				config: { title: "T", retries: 3, verbose: true, mode: "a" },
			},
		});
	});

	it("keeps the previous number on non-finite input and accepts digits", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await openConfig(user);
		const retries = screen.getByRole("spinbutton", { name: /^Retries/ });
		// A plain digit change takes the finite path.
		fireEvent.input(retries, { target: { value: "7" } });
		expect((retries as HTMLInputElement).value).toBe("7");
		// jsdom sanitizes type=number `.value` to valid floats, so a
		// non-finite intermediate ("1e" in a real browser) cannot arrive
		// through the DOM — stub the property to simulate it. Number()
		// of it is NaN → the field keeps its previous value (7).
		Object.defineProperty(retries, "value", {
			configurable: true,
			get: () => "1e",
			set: () => {},
		});
		fireEvent.input(retries);
		await user.click(screen.getByText("Save"));
		expect(fns.setPluginConfigFn).toHaveBeenCalledWith({
			data: {
				pluginId: "v.config",
				config: { title: "T", retries: 7, verbose: false, mode: "a" },
			},
		});
	});

	it("falls back to defaults/empty when the stored config is missing or malformed", async () => {
		const user = userEvent.setup();
		const states = allEnabled();
		states.delete("v.config");
		const { rerender } = render(<PluginsPage plugins={plugins} states={states} locale="en" />);
		await openConfig(user);
		const title = screen.getByRole("textbox", { name: /^Title/ }) as HTMLInputElement;
		const retries = screen.getByRole("spinbutton", { name: /^Retries/ }) as HTMLInputElement;
		// No stored config: optional keys take schema defaults, the
		// required string stays empty, the number field stays unset.
		expect(title.value).toBe("");
		expect(retries.value).toBe("");
		// enum field takes its schema default ("a" — the trigger also
		// renders the select chevron).
		expect(screen.getByRole("combobox", { name: "Mode" }).textContent).toContain("a");
		// A non-object stored config degrades the same way.
		for (const config of [null, [1, 2, 3]]) {
			const odd = allEnabled();
			odd.set("v.config", { pluginId: "v.config", enabled: true, config });
			rerender(<PluginsPage plugins={plugins} states={odd} locale="en" />);
			expect(title.value).toBe("");
		}
	});

	it("shows the empty state when no plugins are registered", () => {
		render(<PluginsPage plugins={[]} states={new Map()} locale="en" />);
		expect(screen.getByText("No plugins discovered.")).toBeTruthy();
	});

	it("surfaces a failure message when the config save is refused or throws", async () => {
		const user = userEvent.setup();
		const save = async () => {
			await openConfig(user);
			await user.click(screen.getByText("Save"));
		};
		// Refused write (ok === false) → failed span inside the form.
		fns.setPluginConfigFn.mockResolvedValueOnce(false);
		const first = render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await save();
		expect(await screen.findByText("Could not save the configuration.")).toBeTruthy();
		expect(invalidate).not.toHaveBeenCalled();
		first.unmount();
		// Thrown write (get or set) → same failure path.
		fns.getPluginConfigFn.mockRejectedValueOnce(new Error("boom"));
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await save();
		expect(await screen.findByText("Could not save the configuration.")).toBeTruthy();
	});

	it("filters rows by search text and reports the filtered count", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await user.type(screen.getByLabelText("Filter plugins"), "v.other");
		expect(screen.queryAllByText("v.base")).toHaveLength(0);
		expect(screen.getAllByText("v.other").length).toBeGreaterThan(0);
		expect(screen.getByText("Showing 1 of 5")).toBeTruthy();
	});

	it("filters rows by status through the toolbar select", async () => {
		const user = userEvent.setup();
		const states = allEnabled();
		states.set("v.other", { pluginId: "v.other", enabled: false, config: null });
		render(<PluginsPage plugins={plugins} states={states} locale="en" />);
		await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
		await user.click(await screen.findByRole("option", { name: "Disabled" }));
		expect(screen.queryAllByText("v.base")).toHaveLength(0);
		expect(screen.getAllByText("v.other").length).toBeGreaterThan(0);
		expect(screen.getByText("Showing 1 of 5")).toBeTruthy();
	});

	it("shows a no-results row when filters match nothing", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await user.type(screen.getByLabelText("Filter plugins"), "zzz-no-match");
		expect(screen.getByText("No plugins match the current filters.")).toBeTruthy();
	});

	it("paginates rows beyond the page size", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 20 }, (_, i) => dep(`p.${i}`));
		render(<PluginsPage plugins={many} states={new Map()} locale="en" />);
		expect(screen.getAllByText("p.0").length).toBeGreaterThan(0);
		expect(screen.queryAllByText("p.19")).toHaveLength(0);
		await user.click(screen.getByText("Next"));
		expect(screen.queryAllByText("p.0")).toHaveLength(0);
		expect(screen.getAllByText("p.19").length).toBeGreaterThan(0);
	});

	it("paginates with numbered pages and the previous/next links", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 20 }, (_, i) => dep(`p.${i}`));
		const { container } = render(<PluginsPage plugins={many} states={new Map()} locale="en" />);
		// PaginationLink renders an <a> without href — no link role; its
		// label text is split across the chevron and the label span.
		const prevLink = () =>
			container.querySelector('a[aria-label="Go to previous page"]') as HTMLElement;
		const nextLink = () =>
			container.querySelector('a[aria-label="Go to next page"]') as HTMLElement;
		// Edge no-ops: previous on page 1, next on the last page.
		await user.click(prevLink());
		expect(screen.getAllByText("p.0").length).toBeGreaterThan(0);
		await user.click(screen.getByText("2", { selector: "a" }));
		expect(screen.queryAllByText("p.0")).toHaveLength(0);
		expect(screen.getAllByText("p.19").length).toBeGreaterThan(0);
		await user.click(nextLink());
		expect(screen.getAllByText("p.19").length).toBeGreaterThan(0);
		await user.click(prevLink());
		expect(screen.getAllByText("p.0").length).toBeGreaterThan(0);
	});

	it("windows page numbers with ellipses on large catalogs", async () => {
		const user = userEvent.setup();
		const many = Array.from({ length: 160 }, (_, i) => dep(`p.${i}`));
		render(<PluginsPage plugins={many} states={new Map()} locale="en" />);
		// 11 pages → the window shows an ellipsis gap before the last page.
		expect(screen.getByText("More pages")).toBeTruthy();
		await user.click(screen.getByText("11", { selector: "a" }));
		expect(screen.getAllByText("More pages").length).toBeGreaterThan(0);
	});

	it("toggles enablement from the row actions menu", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Actions for v.other" }));
		await user.click(await screen.findByRole("menuitem", { name: "Disable" }));
		expect(fns.setPluginEnabledFn).toHaveBeenCalledWith({
			data: { ids: ["v.other"], enabled: false },
		});
	});

	it("counts system plugins as enabled under the status filter", async () => {
		const user = userEvent.setup();
		const sys = definePlugin({ id: "v.sys", system: true });
		const states = statesOf({ "v.sys": { enabled: true } });
		render(<PluginsPage plugins={[sys]} states={states} locale="en" />);
		await user.click(screen.getByRole("combobox", { name: "Filter by status" }));
		await user.click(await screen.findByRole("option", { name: "Enabled" }));
		expect(screen.getAllByText("v.sys").length).toBeGreaterThan(0);
	});

	it("closes the config dialog via its close button", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await openConfig(user);
		expect(screen.getByText("Configure Configurable")).toBeTruthy();
		await user.click(screen.getByRole("button", { name: "Close" }));
		await waitFor(() => expect(screen.queryByText("Configure Configurable")).toBeNull());
	});

	it("opens the config dialog for a plugin without a description", async () => {
		const user = userEvent.setup();
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		await user.click(screen.getByRole("button", { name: "Actions for BareConfig" }));
		await user.click(await screen.findByRole("menuitem", { name: "Configure" }));
		expect(screen.getByText("Configure BareConfig")).toBeTruthy();
		// The id renders both in the row and in the dialog description.
		expect(screen.getAllByText("v.confignodesc").length).toBeGreaterThan(1);
	});

	it("lists multiple contribution kinds and dashes for plugins with none", () => {
		// The Plugin union allows one contribution field per plugin, but
		// the view joins whatever kinds a descriptor carries — exercise
		// the multi-kind path with a cast.
		const rich = definePlugin({
			id: "v.rich",
			tables: {},
			chrome: [],
		} as unknown as Plugin);
		const states = allEnabled();
		states.set("v.rich", { pluginId: "v.rich", enabled: true, config: null });
		render(<PluginsPage plugins={[...plugins, rich]} states={states} locale="en" />);
		expect(screen.getByText("tables, chrome")).toBeTruthy();
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("renders serverFn and session-context metric rows once loaded", async () => {
		fns.getMetricsFn.mockResolvedValue({
			serverFns: [
				{ fn: "abc123", requests: 12, errors: 2, avgDurationMs: 42.4 },
				{ fn: "def456", requests: 3, errors: 0, avgDurationMs: null },
			],
			sessionContexts: [{ context: "session", lookups: 10, loads: 3, avgLoadDurationMs: 8.6 }],
		});
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(await screen.findByText("Runtime metrics")).toBeTruthy();
		expect(screen.getByText("Cumulative since process start.")).toBeTruthy();
		expect(screen.getByText("Server functions")).toBeTruthy();
		expect(screen.getByText("abc123")).toBeTruthy();
		expect(screen.getByText("def456")).toBeTruthy();
		expect(screen.getByText("Session context")).toBeTruthy();
		expect(screen.getByText("session")).toBeTruthy();
		// Averages are rounded to whole ms; a null avg renders an em dash.
		expect(screen.getByText("42")).toBeTruthy();
		expect(screen.getByText("9")).toBeTruthy();
		// Em dash marks the null avg (plugin kind cells render "—" too).
		expect(screen.getAllByText("—").length).toBeGreaterThan(0);
	});

	it("shows the metrics empty state when nothing was recorded", async () => {
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(
			await screen.findByText("No server function or session context traffic recorded yet."),
		).toBeTruthy();
	});

	it("treats a null metrics response as empty", async () => {
		fns.getMetricsFn.mockResolvedValue(null);
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(
			await screen.findByText("No server function or session context traffic recorded yet."),
		).toBeTruthy();
	});

	it("surfaces a metrics error when the fetch rejects", async () => {
		fns.getMetricsFn.mockRejectedValueOnce(new Error("boom"));
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(await screen.findByText("Could not load runtime metrics.")).toBeTruthy();
	});

	it("renders only the session-context table when no serverFn rows exist", async () => {
		fns.getMetricsFn.mockResolvedValue({
			serverFns: [],
			sessionContexts: [{ context: "doctor", lookups: 4, loads: 1, avgLoadDurationMs: 3 }],
		});
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(await screen.findByText("Session context")).toBeTruthy();
		expect(screen.queryByText("Server functions")).toBeNull();
	});

	it("renders only the serverFn table when no session-context rows exist", async () => {
		fns.getMetricsFn.mockResolvedValue({
			serverFns: [{ fn: "abc123", requests: 1, errors: 0, avgDurationMs: 5 }],
			sessionContexts: [],
		});
		render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		expect(await screen.findByText("Server functions")).toBeTruthy();
		expect(screen.queryByText("Session context")).toBeNull();
	});

	it("ignores a metrics response that resolves after unmount", async () => {
		let resolve!: (v: unknown) => void;
		fns.getMetricsFn.mockReturnValueOnce(
			new Promise((r) => {
				resolve = r;
			}),
		);
		const { unmount } = render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		unmount();
		resolve({ serverFns: [], sessionContexts: [] });
		await Promise.resolve();
		expect(fns.getMetricsFn).toHaveBeenCalledTimes(1);
	});

	it("ignores a metrics rejection that lands after unmount", async () => {
		let reject!: (e: unknown) => void;
		fns.getMetricsFn.mockReturnValueOnce(
			new Promise((_r, rej) => {
				reject = rej;
			}),
		);
		const { unmount } = render(<PluginsPage plugins={plugins} states={allEnabled()} locale="en" />);
		unmount();
		reject(new Error("boom"));
		await Promise.resolve();
		expect(fns.getMetricsFn).toHaveBeenCalledTimes(1);
	});
});
