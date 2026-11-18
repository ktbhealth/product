import { useMemo, useState } from "react";

import type { PageContext } from "@ktb/kernel";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@ktbhealth/ui/components/empty";

import { collectFormDefinitions, formIdFromPath } from "./definition.ts";
import { SchemaForm } from "./form.tsx";
import { formsMessages } from "./i18n.ts";

/**
 * `/forms/<id>` — the standalone host for contributed `form.def`
 * entries. The wildcard descriptor's loader returns the request path;
 * this component resolves the id against `ctx.plugins` (the
 * enabled-filtered client registry, so a disabled contributor's form
 * 404s exactly like an unknown path) and renders the definition with
 * SchemaForm. Submissions are preview-only here — owner plugins that
 * embed SchemaForm directly supply the real onSubmit.
 */
export const FormsPage = ({ data, ctx }: { data: unknown; ctx: PageContext }) => {
	const messages = formsMessages(ctx.locale);
	const definitions = useMemo(() => collectFormDefinitions(ctx.plugins), [ctx.plugins]);
	const [submitted, setSubmitted] = useState(false);
	const id = typeof data === "string" ? formIdFromPath(data) : null;
	const definition = id === null ? undefined : definitions.find((def) => def.id === id);

	if (definition === undefined) {
		return (
			<Empty className="py-16">
				<EmptyHeader>
					<EmptyTitle>{messages.notFoundTitle}</EmptyTitle>
					<EmptyDescription>{messages.notFoundDescription}</EmptyDescription>
				</EmptyHeader>
			</Empty>
		);
	}

	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">
					{definition.title ?? definition.id}
				</h1>
			</header>
			<SchemaForm
				definition={definition}
				messages={messages}
				idPrefix={`form-${definition.id}`}
				onSubmit={() => setSubmitted(true)}
			/>
			{submitted && (
				<p role="status" className="text-sm text-muted-foreground">
					{messages.submittedPreview}
				</p>
			)}
		</div>
	);
};
