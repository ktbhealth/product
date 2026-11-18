import { promptsCreateFn, promptsRemoveFn, promptsUpdateFn } from "./fns.ts";
import type { PromptCard } from "./prompts.ts";

/** Mutation surface for the prompts view — bound to the plugin's
 * server fns here so tests can substitute a stub. */
export interface PromptsApi {
	readonly create: (input: {
		readonly name: string;
		readonly template: string;
		readonly version?: number | null;
		readonly locale?: string | null;
		readonly variables?: readonly {
			name: string;
			required?: boolean;
			description?: string;
		}[];
		readonly modelHint?: string | null;
		readonly isSystem?: boolean;
		readonly isDefault?: boolean;
	}) => Promise<{ readonly ok: boolean; readonly data?: PromptCard }>;
	readonly update: (input: {
		readonly id: number;
		readonly template?: string;
		readonly variables?: readonly {
			name: string;
			required?: boolean;
			description?: string;
		}[];
		readonly modelHint?: string | null;
		readonly isSystem?: boolean;
		readonly isDefault?: boolean;
		readonly enabled?: boolean;
	}) => Promise<{ readonly ok: boolean; readonly data?: PromptCard }>;
	readonly remove: (id: number) => Promise<{ readonly ok: boolean }>;
}

export const promptsApi: PromptsApi = {
	create: (input) => promptsCreateFn({ data: input }),
	update: (input) => promptsUpdateFn({ data: input }),
	remove: (id) => promptsRemoveFn({ data: { id } }),
};
