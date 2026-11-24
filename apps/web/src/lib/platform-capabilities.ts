import { compileSchema } from "@ktb/json-schema";
import type {
	EventTopicDeclaration,
	JobKindDeclaration,
	SchedulableDeclaration,
} from "@ktb/platform/capabilities";
import type { JobHandlers, JobRegistration } from "@ktb/jobs-port";
import type { EventTopicInfo, JsonValue, JobKindInfo, SchedulableKindInfo } from "@ktb/server-fns";

/**
 * Pure projections over the P-094 capability declarations — kept out of
 * platform.ts so the merge/validation branches are unit-testable
 * without composing the app runtime.
 */

const isJsonSchemaDoc = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Compile every declared `jobs.schedulable.paramsSchema` once at
 * composition — a malformed (non-object) schema fails boot rather than
 * every schedule create. Declared kinds without a schema are skipped;
 * multiple declarations may target the same kind. */
export const compileSchedulableValidators = (
	decls: readonly SchedulableDeclaration[],
): ReadonlyMap<string, readonly ReturnType<typeof compileSchema>[]> => {
	const validators = new Map<string, ReturnType<typeof compileSchema>[]>();
	for (const decl of decls) {
		if (decl.paramsSchema === undefined) continue;
		if (!isJsonSchemaDoc(decl.paramsSchema)) {
			throw new Error(`jobs.schedulable "${decl.id}" paramsSchema must be a JSON Schema object`);
		}
		const list = validators.get(decl.kind) ?? [];
		list.push(compileSchema(decl.paramsSchema));
		validators.set(decl.kind, list);
	}
	return validators;
};

/** A kind is dispatchable when a jobHandlers registration exists or a
 * `jobs.schedulable` declaration targets it (declared kinds may ride
 * transports with special normalizers). */
export const scheduleKindDispatchable = (
	kind: string,
	handlers: JobHandlers,
	schedulableDecls: readonly SchedulableDeclaration[],
): boolean => handlers[kind] !== undefined || schedulableDecls.some((decl) => decl.kind === kind);

/** Validate schedule params against every schema declared for the
 * kind — the value must satisfy at least one. Returns the rejection
 * message, or null when accepted (no validators declared, or a match). */
export const scheduleParamsError = (
	kind: string,
	params: unknown,
	validators: ReadonlyMap<string, readonly ReturnType<typeof compileSchema>[]>,
): string | null => {
	const list = validators.get(kind);
	if (list === undefined) return null;
	const value = params ?? {};
	const match = list.find((validator) => validator.validate(value).length === 0);
	if (match !== undefined) return null;
	// list is non-empty by construction (compileSchedulableValidators only
	// creates lists with at least one validator).
	const issues = list[0]!.validate(value);
	return `params do not match the declared schema for ${kind}: ${issues
		.map((issue) => issue.message)
		.join("; ")}`;
};

/** Handler registration merged with `jobs.kind`/`jobs.schedulable`
 * declarations: `registered` is the live jobHandlers state (a
 * declared-but-unregistered kind is catalog data, not dispatchable);
 * declared concurrency/attempt hints fill in only when the registration
 * leaves them unset. */
export const jobKindInfos = (
	handlers: JobHandlers,
	kindDecls: readonly JobKindDeclaration[],
	schedulableDecls: readonly SchedulableDeclaration[],
): readonly JobKindInfo[] => {
	const declByKind = new Map(kindDecls.map((decl) => [decl.kind, decl]));
	const schedulableKinds = new Set(schedulableDecls.map((decl) => decl.kind));
	const kinds = new Set<string>([
		...Object.keys(handlers),
		...kindDecls.map((decl) => decl.kind),
		...schedulableKinds,
	]);
	return [...kinds].sort().map((kind) => {
		const registration: JobRegistration | undefined = handlers[kind];
		const decl = declByKind.get(kind);
		return {
			kind,
			registered: registration !== undefined,
			schedulable: schedulableKinds.has(kind),
			...(decl?.pluginId === undefined ? {} : { pluginId: decl.pluginId }),
			...(decl?.description === undefined ? {} : { description: decl.description }),
			...(registration?.concurrency === undefined
				? decl?.concurrency === undefined
					? {}
					: { concurrency: decl.concurrency }
				: { concurrency: registration.concurrency }),
			...(registration?.maxAttempts === undefined
				? decl?.maxAttempts === undefined
					? {}
					: { maxAttempts: decl.maxAttempts }
				: { maxAttempts: registration.maxAttempts }),
			idempotent: registration?.idempotent ?? decl?.idempotent ?? false,
		};
	});
};

/** `jobs.schedulable` declarations as the schedule-creation picker sees
 * them. */
export const schedulableKindInfos = (
	decls: readonly SchedulableDeclaration[],
): readonly SchedulableKindInfo[] =>
	decls.map((decl) => ({
		id: decl.id,
		kind: decl.kind,
		pluginId: decl.pluginId,
		...(decl.description === undefined ? {} : { description: decl.description }),
		...(decl.paramsSchema === undefined ? {} : { paramsSchema: decl.paramsSchema as JsonValue }),
		...(decl.suggestedCronExpr === undefined ? {} : { suggestedCronExpr: decl.suggestedCronExpr }),
		...(decl.suggestedParams === undefined
			? {}
			: { suggestedParams: decl.suggestedParams as JsonValue | null }),
	}));

/** `events.topic` declarations as the pub/sub console catalog sees
 * them. */
export const eventTopicInfos = (
	decls: readonly EventTopicDeclaration[],
): readonly EventTopicInfo[] =>
	decls.map((decl) => ({
		topic: decl.topic,
		pluginId: decl.pluginId,
		...(decl.description === undefined ? {} : { description: decl.description }),
		...(decl.payloadSchema === undefined ? {} : { payloadSchema: decl.payloadSchema as JsonValue }),
	}));
