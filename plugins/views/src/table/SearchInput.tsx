import type { ComponentProps } from "react";

import { Input } from "@ktbhealth/ui/components/input";

/**
 * Standard-width search field for `TablePage.Toolbar`'s `search`
 * slot — the `w-56 sm:w-64` sizing every admin list uses today.
 * `onChange` receives the input's string value directly.
 */
export interface SearchInputProps extends Omit<
	ComponentProps<"input">,
	"type" | "value" | "onChange" | "className"
> {
	readonly value: string;
	readonly onChange: (value: string) => void;
	readonly className?: string;
}

export function SearchInput({ value, onChange, className, ...props }: SearchInputProps) {
	return (
		<Input
			type="search"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			className={["w-56", "sm:w-64", className].filter(Boolean).join(" ")}
			{...props}
		/>
	);
}
