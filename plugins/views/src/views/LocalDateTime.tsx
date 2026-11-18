import { useSyncExternalStore, type ReactNode } from "react";

/**
 * SSR-safe locale-formatted date/time.
 *
 * `toLocaleString` resolves in the runtime timezone — UTC on the SSR
 * worker vs the browser's zone — so emitting it during SSR and
 * hydration diverges ("server rendered text didn't match the client").
 * The text is therefore only produced on the client; server and
 * hydration renders show `fallback` instead, keeping markup identical.
 */

export interface LocalDateTimeProps {
	/** Date, epoch ms, or date string — anything `new Date()` accepts. */
	readonly value: Date | number | string | null | undefined;
	/** BCP-47 locale; defaults to the runtime's. */
	readonly locale?: string;
	/** `Intl` options forwarded to `toLocaleString` (dateStyle, …). */
	readonly options?: Intl.DateTimeFormatOptions;
	/** Rendered during SSR/hydration and for nullish or invalid values. */
	readonly fallback?: ReactNode;
}

const subscribe = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function LocalDateTime({
	value,
	locale,
	options,
	fallback = null,
}: LocalDateTimeProps): ReactNode {
	const mounted = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
	if (!mounted || value === null || value === undefined) return fallback;
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return fallback;
	return date.toLocaleString(locale, options);
}
