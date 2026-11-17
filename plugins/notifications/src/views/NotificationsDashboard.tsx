import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import { useContext } from "react";

import {
	NotificationsDataContext,
	NotificationsUnreadContext,
	type ConsoleNotification,
} from "../context.ts";
import { notificationMessages, I18N_NAMESPACE } from "../i18n.ts";

interface DashboardSlotProps {
	readonly locale?: string;
	readonly i18n?: PageI18nSlice;
}

const NotificationBody = ({ notification }: { notification: ConsoleNotification }) => (
	<>
		<span
			className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
				notification.read ? "bg-transparent" : "bg-primary"
			}`}
		/>
		<div className="min-w-0">
			<p className="truncate text-sm">{notification.title}</p>
			{notification.description ? (
				<p className="truncate text-xs text-muted-foreground">{notification.description}</p>
			) : null}
			{notification.meta ? (
				<p className="mt-0.5 text-[11px] text-muted-foreground/70">{notification.meta}</p>
			) : null}
		</div>
	</>
);

/**
 * `portal.dashboard.sections` contribution: the console-activity card —
 * unread count plus the session user's most recent notifications. Rows
 * arrive through NotificationsDataContext (the /platform layout seeds
 * it); the exact unread count comes through NotificationsUnreadContext
 * because the feed is capped and cannot be counted client-side.
 */
export function NotificationsDashboardSections({ locale = "en", i18n }: DashboardSlotProps) {
	const t = sliceMessages(i18n, I18N_NAMESPACE, notificationMessages(locale));
	const notifications = useContext(NotificationsDataContext);
	const exactUnread = useContext(NotificationsUnreadContext);
	const unread = exactUnread ?? notifications.filter((n) => !n.read).length;
	const recent = notifications.slice(0, 5);
	return (
		<section>
			<h2 className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
				{t.dashboard.consoleActivity}
			</h2>
			<div className="mt-2 rounded-lg border border-border px-3 py-2.5">
				<div className="flex items-baseline justify-between">
					<span className="text-[10px] tracking-widest text-muted-foreground uppercase">
						{t.dashboard.unreadNotifications}
					</span>
					<span className="text-lg font-bold">{unread}</span>
				</div>
				{recent.length === 0 ? (
					<p className="mt-2 text-xs text-muted-foreground">{t.dashboard.noNotifications}</p>
				) : (
					<ul className="mt-1 divide-y divide-border">
						{recent.map((n) => (
							<li key={n.id} className="flex gap-2.5 py-2">
								<NotificationBody notification={n} />
							</li>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}
