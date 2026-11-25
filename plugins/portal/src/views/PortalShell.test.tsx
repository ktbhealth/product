// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigate = vi.fn();
vi.mock("@tanstack/react-router", async () => {
	const React = await import("react");
	return {
		Link: ({ to, ...props }: Record<string, unknown>) =>
			React.createElement("a", { ...props, href: String(to) }, props.children as never),
		useNavigate: () => navigate,
	};
});

// Base UI's Select needs pointer/portal plumbing jsdom lacks; render a
// native <select> with the same value/onValueChange contract. Options
// come from SelectItem children; a11y props ride on SelectTrigger and
// are forwarded onto the <select> element.
vi.mock("@ktbhealth/ui/components/select", async () => {
	const React = await import("react");
	const SelectTriggerMock = (props: Record<string, unknown>) =>
		React.createElement("ktb-select-trigger", props);
	const Select = ({
		value,
		onValueChange,
		children,
	}: {
		value?: string | null;
		onValueChange?: (v: string | null) => void;
		children?: React.ReactNode;
	}) => {
		let triggerProps: Record<string, unknown> = {};
		const inner = React.Children.map(children, (child) => {
			if (React.isValidElement(child) && child.type === SelectTriggerMock) {
				const { children: _c, size: _s, ...props } = child.props as Record<string, unknown>;
				triggerProps = props;
				return null;
			}
			return child;
		});
		return React.createElement(
			"select",
			{
				value: value ?? "",
				onChange: (e: { target: { value: string } }) => onValueChange?.(e.target.value),
				...triggerProps,
			},
			inner,
		);
	};
	return {
		Select,
		SelectTrigger: SelectTriggerMock,
		SelectValue: () => null,
		SelectContent: ({ children }: { children?: React.ReactNode }) =>
			React.createElement(React.Fragment, null, children),
		SelectItem: ({ value, children }: { value: string; children?: React.ReactNode }) =>
			React.createElement("option", { value }, children),
	};
});

// jsdom has no matchMedia; the ui sidebar's useIsMobile needs it.
window.matchMedia =
	window.matchMedia ??
	((query: string) =>
		({
			matches: false,
			media: query,
			onchange: null,
			addListener: () => {},
			removeListener: () => {},
			addEventListener: () => {},
			removeEventListener: () => {},
			dispatchEvent: () => false,
		}) as MediaQueryList);

import type { PanelSidebarItem } from "@ktb/kernel";
import { UsersIcon } from "lucide-react";

import { PortalShell } from "./PortalShell.tsx";

const instance = { id: "platform", basePath: "/platform", label: "Platform" };
const doctor = { id: "doctor", basePath: "/portal/doctor", label: "Doctor" };

const items: PanelSidebarItem[] = [
	{ to: "/platform", label: "Dashboard", exact: true },
	{ to: "/platform/users", label: "Users", icon: UsersIcon, group: "Access" },
	{ to: "/platform/groups", label: "Groups", group: "Access" },
];

const renderShell = (over: Partial<Parameters<typeof PortalShell>[0]> = {}) =>
	render(
		<PortalShell
			instance={instance}
			items={items}
			pathname="/platform/users"
			userEmail="admin@x.com"
			onSignOut={vi.fn()}
			{...over}
		>
			<div>page body</div>
		</PortalShell>,
	);

afterEach(() => {
	cleanup();
	navigate.mockClear();
});

describe("PortalShell", () => {
	it("renders grouped sidebar items and the matched breadcrumb leaf", () => {
		const { container } = renderShell();
		expect(screen.getByText("Dashboard")).toBeDefined();
		expect(screen.getByText("Access")).toBeDefined();
		expect(screen.getByText("Groups")).toBeDefined();
		expect(screen.getByText("page body")).toBeDefined();
		// "Users" appears twice: sidebar item + breadcrumb leaf label
		expect(screen.getAllByText("Users")).toHaveLength(2);
		expect(container.querySelector('a[href="/platform/users"]')).not.toBeNull();
	});

	it("renders an item's badge component next to its label (PL-023)", () => {
		const QueueBadge = ({ locale }: { readonly locale?: string }) => (
			<span data-testid="queue-badge">{locale}:3</span>
		);
		renderShell({
			items: [
				...items,
				{ to: "/platform/consultations", label: "Consultations", badge: QueueBadge },
			],
		});
		expect(screen.getByText("Consultations")).toBeDefined();
		expect(screen.getByTestId("queue-badge")).toBeDefined();
		// The host injects the shell locale into the badge contract.
		expect(screen.getByTestId("queue-badge").textContent).toContain("en");
	});

	it("anchors breadcrumbs at the deepest active sidebar item", () => {
		renderShell({
			items: [...items, { to: "/platform/users/admins", label: "Admins" }],
			pathname: "/platform/users/admins/u9",
		});
		// Both "Users" and "Admins" match — the sort picks the longest
		// `to` as the anchor and the trailing segment becomes the leaf.
		expect(screen.getAllByText("Admins").length).toBeGreaterThan(0);
		expect(screen.getByText("U9")).toBeDefined();
	});

	it("uses 'overview' leaf on the instance index", () => {
		renderShell({ pathname: "/platform" });
		expect(screen.getByText("Overview")).toBeDefined();
	});

	it("falls back to the last path segment for unmatched routes", () => {
		renderShell({ pathname: "/platform/unknown-thing" });
		expect(screen.getByText("Unknown-thing")).toBeDefined();
	});

	it("falls back to 'overview' when the path has no segments", () => {
		renderShell({ pathname: "/" });
		expect(screen.getByText("Overview")).toBeDefined();
	});

	it("badges the header with the instance label and links the breadcrumb root to its basePath", () => {
		const { container } = renderShell();
		// Instance label renders in the sidebar badge and the breadcrumb root.
		expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
		expect(container.querySelector('a[href="/platform"]')).not.toBeNull();
	});

	it("hides the portal switcher below two instances", () => {
		renderShell({ portals: [instance] });
		expect(screen.queryByLabelText("Switch portal")).toBeNull();
		renderShell();
		expect(screen.queryByLabelText("Switch portal")).toBeNull();
	});

	it("switches portals through the footer picker", async () => {
		const user = userEvent.setup();
		renderShell({ portals: [instance, doctor] });
		const select = screen.getByLabelText("Switch portal") as HTMLSelectElement;
		expect(select.value).toBe("platform");
		await user.selectOptions(select, "doctor");
		expect(navigate).toHaveBeenCalledWith({ to: "/portal/doctor" });
	});

	it("ignores switcher values that match no portal", () => {
		renderShell({ portals: [instance, doctor] });
		const select = screen.getByLabelText("Switch portal") as HTMLSelectElement;
		fireEvent.change(select, { target: { value: "ghost" } });
		expect(navigate).not.toHaveBeenCalled();
	});

	it("shows the generic account label without a user email", () => {
		renderShell({ userEmail: undefined });
		expect(screen.getByText("account")).toBeDefined();
	});

	it("calls onSignOut from the footer button", async () => {
		const user = userEvent.setup();
		const onSignOut = vi.fn();
		renderShell({ onSignOut });
		await user.click(screen.getByTitle("Sign out"));
		expect(onSignOut).toHaveBeenCalledTimes(1);
	});

	it("renders an empty brand slot when no brand is provided (PL-006)", () => {
		// Brand lives in theme data — the shell has no hardcoded
		// wordmark fallback; only the host-owned instance badge stays.
		renderShell();
		expect(screen.queryByText("KTB")).toBeNull();
		expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
	});

	it("renders a custom brand in the fixed sidebar slot and keeps the badge", () => {
		renderShell({ brand: <span data-testid="brand-mark">Acme Health</span> });
		expect(screen.getByTestId("brand-mark")).toBeDefined();
		expect(screen.queryByText("KTB")).toBeNull();
		// The host-owned instance badge still renders next to the brand.
		expect(screen.getAllByText("Platform").length).toBeGreaterThan(0);
	});

	it("renders the banner strip above the header when provided", () => {
		renderShell({ banner: <div data-testid="preview-banner">preview</div> });
		expect(screen.getByTestId("preview-banner")).toBeDefined();
	});

	it("injects the theme css block only when it carries content (P-082)", () => {
		const marker = ":root{--ktb-shell-marker:1}";
		const { container, unmount } = renderShell({ themeCss: marker });
		expect(container.innerHTML).toContain("--ktb-shell-marker");
		unmount();
		// null / "" / undefined all skip the single style emitter.
		for (const themeCss of [null, "", undefined] as const) {
			const r = renderShell({ themeCss });
			expect(r.container.innerHTML).not.toContain("--ktb-shell-marker");
			r.unmount();
		}
	});
});
