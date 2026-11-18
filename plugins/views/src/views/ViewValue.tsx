import type { ReactNode } from "react";

import type { ViewField } from "../definition.ts";
import { LocalDateTime } from "./LocalDateTime.tsx";
import { formatViewValue } from "./view-utils.ts";

export interface ViewValueProps {
	readonly field: ViewField;
	readonly value: unknown;
	readonly locale?: string;
	readonly refs?: Readonly<Record<string, string>>;
}

/**
 * SSR-safe cell/field renderer. `date`-format epoch-ms values go
 * through {@link LocalDateTime} — `toLocaleString` resolves in the
 * runtime timezone, so emitting it during SSR mismatches hydration.
 * Every other format delegates to the pure `formatViewValue` string
 * path (numbers/booleans/refs/json are locale-stable given `locale`).
 */
export function ViewValue({ field, value, locale, refs }: ViewValueProps): ReactNode {
	if (field.format === "date" && typeof value === "number" && Number.isFinite(value)) {
		return <LocalDateTime value={value} locale={locale} />;
	}
	return formatViewValue(field, value, { locale, refs });
}
