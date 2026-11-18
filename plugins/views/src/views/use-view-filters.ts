import { useState } from "react";

import type { ViewListWire } from "../wire.ts";
import {
	currentSearch,
	filterSearchFromValues,
	filterValuesFromSearch,
	replaceFilterSearch,
} from "./view-utils.ts";

/**
 * Shared filter/pagination state for the list views: interactive
 * filter values initialize from the URL search params (so a shared or
 * refreshed link restores the same query), and every change writes
 * the params back via replaceState AND refetches page 0 through the
 * owner's `onQuery`.
 */
export const useViewFilters = (
	wire: ViewListWire,
	onQuery: (offset: number, values: Readonly<Record<string, string>>) => void,
): {
	readonly values: Readonly<Record<string, string>>;
	readonly apply: (values: Record<string, string>) => void;
} => {
	const [values, setValues] = useState<Readonly<Record<string, string>>>(() =>
		filterValuesFromSearch(wire.def, currentSearch()),
	);
	const apply = (next: Record<string, string>) => {
		setValues(next);
		replaceFilterSearch(filterSearchFromValues(wire.def, next));
		onQuery(0, next);
	};
	return { values, apply };
};
