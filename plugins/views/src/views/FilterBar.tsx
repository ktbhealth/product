import { Button } from "@ktbhealth/ui/components/button";
import { Field, FieldLabel } from "@ktbhealth/ui/components/field";
import { Input } from "@ktbhealth/ui/components/input";

import type { ViewDef } from "../definition.ts";
import { filterParam, interactiveFilters } from "../plan.ts";
import type { ViewMessages } from "../i18n.ts";
import { filterLabel } from "./view-utils.ts";

/**
 * Declared-filter bar shared by the list views: one labeled input per
 * INTERACTIVE filter (fixed `value` filters never render — they are
 * always applied server-side). Values live in the URL search params
 * (see view-utils) and every change refetches page 0 through the
 * owner's `onChange`.
 */
export interface FilterBarProps {
	readonly def: ViewDef;
	readonly messages: ViewMessages;
	readonly values: Readonly<Record<string, string>>;
	readonly onChange: (values: Record<string, string>) => void;
	readonly disabled?: boolean;
}

export function FilterBar({ def, messages, values, onChange, disabled }: FilterBarProps) {
	const filters = interactiveFilters(def);
	if (filters.length === 0) return null;
	return (
		<form className="flex flex-wrap items-end gap-3" onSubmit={(e) => e.preventDefault()}>
			<fieldset className="contents">
				<legend className="sr-only">{messages.filtersLabel}</legend>
				{filters.map((filter) => {
					const param = filterParam(filter);
					const id = `view-filter-${param}`;
					return (
						<Field key={param} className="w-48">
							<FieldLabel htmlFor={id}>{filterLabel(filter)}</FieldLabel>
							<Input
								id={id}
								value={values[param] ?? ""}
								disabled={disabled}
								onChange={(e) => {
									const next = { ...values, [param]: e.target.value };
									onChange(next);
								}}
							/>
						</Field>
					);
				})}
			</fieldset>
			<Button
				type="button"
				size="sm"
				variant="outline"
				disabled={disabled}
				onClick={() => onChange({})}
			>
				{messages.resetFilters}
			</Button>
		</form>
	);
}
