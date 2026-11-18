import { modelsCreateFn, modelsRemoveFn, modelsUpdateFn } from "./fns.ts";
import type { ModelCard } from "./models.ts";

/** Mutation surface for the models view — bound to the plugin's
 * server fns here so tests can substitute a stub. */
export interface ModelsApi {
	readonly create: (input: {
		readonly name: string;
		readonly modelId: string;
		readonly endpointId?: number | null;
		readonly kind?: string;
		readonly capabilities?: readonly string[];
		readonly contextTokens?: number | null;
		readonly costTier?: string | null;
		readonly isDefault?: boolean;
	}) => Promise<{ readonly ok: boolean; readonly data?: ModelCard }>;
	readonly update: (input: {
		readonly id: number;
		readonly name?: string;
		readonly modelId?: string;
		readonly endpointId?: number | null;
		readonly kind?: string;
		readonly capabilities?: readonly string[];
		readonly contextTokens?: number | null;
		readonly costTier?: string | null;
		readonly isDefault?: boolean;
		readonly enabled?: boolean;
	}) => Promise<{ readonly ok: boolean; readonly data?: ModelCard }>;
	readonly remove: (id: number) => Promise<{ readonly ok: boolean }>;
}

export const modelsApi: ModelsApi = {
	create: (input) => modelsCreateFn({ data: input }),
	update: (input) => modelsUpdateFn({ data: input }),
	remove: (id) => modelsRemoveFn({ data: { id } }),
};
