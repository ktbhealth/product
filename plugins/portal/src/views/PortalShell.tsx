import { Fragment, type ComponentType, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { LogOutIcon } from "lucide-react";

import {
	Breadcrumb,
	BreadcrumbItem,
	BreadcrumbLink,
	BreadcrumbList,
	BreadcrumbPage,
	BreadcrumbSeparator,
} from "@ktbhealth/ui/components/breadcrumb";
import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";

import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ktbhealth/ui/components/select";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "@ktbhealth/ui/components/sidebar";
import type { PanelSidebarItem } from "@ktb/kernel";

import { portalMessages, I18N_NAMESPACE } from "../i18n.ts";

/** The portal instance this shell renders — a client-safe projection
 * of the kernel `PortalInstance` (id/basePath/label/icon). */
export interface PortalShellInstance {
	readonly id: string;
	readonly basePath: string;
	readonly label: string;
	readonly icon?: ComponentType<{ readonly className?: string }>;
}

export interface PortalShellProps {
	/** The instance being rendered. */
	readonly instance: PortalShellInstance;
	/** Aggregated `portal.sidebar` chrome items scoped to this instance,
	 * in topo order. */
	readonly items: readonly PanelSidebarItem[];
	readonly pathname: string;
	/** Optional right-side header widgets contributed via
	 * `portal.header.actions` chrome. */
	readonly headerActions?: ReactNode;
	/** Optional brand slot rendered in the SidebarHeader fixed box
	 * (P-082/PL-006): the host composes the resolved theme's brand
	 * mark plus any `portal.brand` chrome components. Absent → the
	 * slot renders empty — brand lives in theme data only, there is
	 * no hardcoded wordmark. The instance badge below it is always
	 * host-rendered. */
	readonly brand?: ReactNode;
	/** Optional banner strip above the header — the host uses it for
	 * the theme-preview marker (P-082). */
	readonly banner?: ReactNode;
	/** Theme override CSS (`:root`/`.dark` custom properties, P-082):
	 * the host route injects the resolved theme's block here so the
	 * portal shell owns exactly one style emitter per page. */
	readonly themeCss?: string | null;
	/** Active UI locale — injected by the host route. */
	/** DB catalog slice for this route's namespaces (PL-008). */
	i18n?: PageI18nSlice;
	readonly locale?: string;
	readonly userEmail?: string;
	/** Every instance the user may enter (audience-filtered by the host),
	 * current included — drives the footer switcher. Fewer than two
	 * hides it. */
	readonly portals?: readonly PortalShellInstance[];
	/** Injected by the host — plugins cannot import the auth client. */
	readonly onSignOut: () => void | Promise<void>;
	readonly children?: ReactNode;
}

const isItemActive = (pathname: string, item: PanelSidebarItem) =>
	item.exact ? pathname === item.to : pathname === item.to || pathname.startsWith(`${item.to}/`);

/**
 * Portal chrome (P-081): the generalized console shell — fixed sidebar
 * aggregating the instance's `portal.sidebar` chrome items (grouped by
 * `group`, ungrouped pinned first), dense breadcrumb top bar, footer
 * with the portal switcher and sign-out. Purely presentational — the
 * host route owns the audience gate and injects items/pathname/
 * instance/switcher entries/sign-out. `/platform` renders it with the
 * "platform" instance; namespaced portals (`/portal/<id>/*`) with
 * theirs.
 */
export function PortalShell({
	instance,
	items,
	pathname,
	headerActions,
	brand,
	banner,
	themeCss,
	i18n,

	locale = "en",
	userEmail,
	portals,
	onSignOut,
	children,
}: PortalShellProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, portalMessages(locale));
	const navigate = useNavigate();
	// Group sidebar items by their `group` label, preserving the
	// flattened topo order — groups order by first appearance, with the
	// ungrouped section pinned to the top.
	const groups = new Map<string, PanelSidebarItem[]>();
	for (const item of items) {
		const key = item.group ?? "";
		const list = groups.get(key) ?? [];
		list.push(item);
		groups.set(key, list);
	}
	const orderedGroups = [...groups.entries()].sort(
		([a], [b]) => Number(a !== "") - Number(b !== ""),
	);
	// Breadcrumb trail: instance root → deepest matching sidebar item →
	// remaining path segments (humanized). The last crumb renders as the
	// current page; everything before it links.
	const anchor = items
		.filter((i) => isItemActive(pathname, i) && i.to !== instance.basePath)
		.sort((a, b) => b.to.length - a.to.length)[0];
	const crumbs: { label: string; to?: string }[] = [
		{ label: instance.label, to: instance.basePath },
	];
	if (pathname === instance.basePath) {
		crumbs.push({ label: t.overview });
	} else {
		const base = anchor?.to ?? instance.basePath;
		if (anchor !== undefined) {
			crumbs.push({ label: anchor.label, to: anchor.to });
		}
		const rest = pathname.slice(base.length).split("/").filter(Boolean);
		if (rest.length === 0 && anchor === undefined) {
			crumbs.push({ label: t.overview });
		}
		rest.forEach((seg, i) => {
			crumbs.push({
				label: seg.charAt(0).toUpperCase() + seg.slice(1),
				to: `${base}/${rest.slice(0, i + 1).join("/")}`,
			});
		});
	}
	return (
		<SidebarProvider className="h-dvh min-h-0">
			{/* Exactly one theme style block per portal page (P-082):
			    :root + .dark overrides resolved server-side by the route
			    loader. .dark stays user-preference driven — the block only
			    redefines the custom properties inside it. */}
			{themeCss !== undefined && themeCss !== null && themeCss !== "" ? (
				<style dangerouslySetInnerHTML={{ __html: themeCss }} />
			) : null}
			<Sidebar collapsible="none" className="border-sidebar-border border-r">
				<SidebarHeader>
					<div className="flex items-center gap-2 px-2 pt-1">
						{/* Fixed-height brand slot (P-082): brand content
						    (logo/wordmark) must size itself — never intrinsic
						    image size — so a theme swap can't shift layout.
						    Empty when the theme carries no brand; the
						    instance badge stays host-owned either way. */}
						<div className="flex h-6 min-w-0 items-center overflow-hidden">{brand}</div>
						<span className="rounded border border-sidebar-border px-1 py-0.5 text-[10px] text-muted-foreground uppercase">
							{instance.label}
						</span>
					</div>
				</SidebarHeader>
				<SidebarContent>
					{orderedGroups.map(([name, groupItems]) => (
						<SidebarGroup key={name || "__default__"}>
							{name ? (
								<SidebarGroupLabel className="text-[10px] tracking-widest uppercase">
									{name}
								</SidebarGroupLabel>
							) : null}
							<SidebarGroupContent>
								<SidebarMenu>
									{groupItems.map((item) => (
										<SidebarMenuItem key={item.to}>
											<SidebarMenuButton
												render={<Link to={item.to} />}
												isActive={isItemActive(pathname, item)}
											>
												{item.icon ? <item.icon /> : null}
												<span>{item.label}</span>
												{item.badge ? (
													<span className="ml-auto">
														<item.badge locale={locale} i18n={i18n} />
													</span>
												) : null}
											</SidebarMenuButton>
										</SidebarMenuItem>
									))}
								</SidebarMenu>
							</SidebarGroupContent>
						</SidebarGroup>
					))}
				</SidebarContent>
				<SidebarFooter>
					<div className="flex items-center justify-between gap-2 px-2 pb-1">
						<span className="truncate text-[11px] text-muted-foreground">
							{userEmail ?? t.userFallback}
						</span>
						<button
							type="button"
							className="rounded p-1 text-muted-foreground transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
							title={t.signOut}
							onClick={() => void onSignOut()}
						>
							<LogOutIcon className="size-3.5" />
						</button>
					</div>
					{portals !== undefined && portals.length > 1 ? (
						<div className="px-2 pb-2">
							<Select
								items={portals.map((p) => ({ value: p.id, label: p.label }))}
								value={instance.id}
								onValueChange={(v) => {
									const target = portals.find((p) => p.id === v);
									if (target !== undefined) void navigate({ to: target.basePath });
								}}
							>
								<SelectTrigger aria-label={t.switcherLabel} size="sm" className="w-full">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{portals.map((p) => (
										<SelectItem key={p.id} value={p.id}>
											{p.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					) : null}
				</SidebarFooter>
			</Sidebar>
			<div className="flex min-w-0 flex-1 flex-col">
				{banner}
				<header className="flex h-11 shrink-0 items-center gap-3 border-b border-border px-4">
					<Breadcrumb className="text-xs">
						<BreadcrumbList>
							{crumbs.map((crumb, i) => (
								<Fragment key={crumb.to ?? crumb.label}>
									{i > 0 ? <BreadcrumbSeparator /> : null}
									<BreadcrumbItem>
										{crumb.to !== undefined && i < crumbs.length - 1 ? (
											<BreadcrumbLink render={<Link to={crumb.to} />}>{crumb.label}</BreadcrumbLink>
										) : (
											<BreadcrumbPage>{crumb.label}</BreadcrumbPage>
										)}
									</BreadcrumbItem>
								</Fragment>
							))}
						</BreadcrumbList>
					</Breadcrumb>
					<div className="ml-auto flex items-center gap-2">{headerActions}</div>
				</header>
				<main className="min-h-0 flex-1 overflow-auto p-4">{children}</main>
			</div>
		</SidebarProvider>
	);
}
