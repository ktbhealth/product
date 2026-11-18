import {
	machinesBeatFn,
	machinesCheckAllFn,
	machinesCheckFn,
	machinesCreateFn,
	machinesRemoveFn,
	machinesUpdateFn,
} from "./fns.ts";
import type { MachineCard } from "./machines.ts";

/** Mutation surface for the machines view — bound to the plugin's
 * server fns here so tests can substitute a stub. Wire payloads carry
 * `vault:` refs only, never secret material. */
export interface MachinesApi {
	readonly create: (input: {
		readonly name: string;
		readonly kind?: string;
		readonly host: string;
		readonly port?: number | null;
		readonly capabilities?: readonly string[];
		readonly secretRef?: string | null;
		readonly healthUrl?: string | null;
	}) => Promise<{ readonly ok: boolean; readonly data?: MachineCard }>;
	readonly update: (input: {
		readonly id: number;
		readonly name?: string;
		readonly kind?: string;
		readonly host?: string;
		readonly port?: number | null;
		readonly capabilities?: readonly string[];
		readonly secretRef?: string | null;
		readonly healthUrl?: string | null;
		readonly enabled?: boolean;
	}) => Promise<{ readonly ok: boolean; readonly data?: MachineCard }>;
	readonly remove: (id: number) => Promise<{ readonly ok: boolean }>;
	readonly check: (
		id: number,
	) => Promise<{ readonly ok: boolean; readonly data?: MachineCard | null }>;
	readonly checkAll: () => Promise<{
		readonly ok: boolean;
		readonly data?: readonly MachineCard[];
	}>;
	readonly beat: (id: number) => Promise<{ readonly ok: boolean }>;
}

export const machinesApi: MachinesApi = {
	create: (input) => machinesCreateFn({ data: input }),
	update: (input) => machinesUpdateFn({ data: input }),
	remove: (id) => machinesRemoveFn({ data: { id } }),
	check: (id) => machinesCheckFn({ data: { id } }),
	checkAll: () => machinesCheckAllFn(),
	beat: (id) => machinesBeatFn({ data: { id } }),
};
