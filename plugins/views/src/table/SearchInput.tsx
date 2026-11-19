import type { ComponentProps } from "react";

import { Input } from "@ktbhealth/ui/components/input";

/**
 * Standard-width search field for `TablePage.Toolbar`'s `search`
 * slot — the `w-56 sm:w-64` sizing every admin list uses today.
 * `onChange` receives the input's string value directly.
 *
 * `className` is appended after the default width utilities, so a
 * caller-supplied width (e.g. `w-72 sm:w-80`) overrides them —
 * `Input` resolves conflicting utilities via tailwind-merge, last
 * wins. `onSubmit`, when provided, wraps the field in a
 * `<form onSubmit>` (`display: contents`, so toolbar layout is
 * unchanged) and fires `onSubmit(value)` on Enter — for
 * submit-to-apply filters instead of per-keystroke `onChange`.
 */
export interface SearchInputProps extends Omit<
	ComponentProps<"input">,
	"type" | "value" | "onChange" | "className" | "onSubmit"
> {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly className?: string;
	/** Enter-to-apply handler — receives the current `value`. */
	readonly onSubmit?: (value: string) => void;
}

export function SearchInput({ value, onChange, className, onSubmit, ...props }: SearchInputProps) {
	const input = (
		<Input
			type="search"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={["w-56", "sm:w-64", className].filter(Boolean).join(" ")}
			{...props}
		/>
	);
	if (onSubmit === undefined) return input;
	return (
		<form
			className="contents"
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit(value);
			}}
		>
			{input}
		</form>
	);
}
