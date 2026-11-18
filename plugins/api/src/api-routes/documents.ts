import { createPluginApiRoute } from "@ktb/server-fns";

import { apiError, toErrorResponse } from "../http.ts";

/**
 * `/api/documents` — the collection-level root. There is no index
 * endpoint: collection names are not enumerable over HTTP (default-deny
 * — see ../exposure.ts), so the bare path answers the same 404 envelope
 * as an unknown key rather than leaking which collections exist.
 */
const notFound = () =>
	Promise.resolve(toErrorResponse(apiError(404, "not_found", "collection name required")));

export const Route = createPluginApiRoute("api.routes")("/api/documents")({
	server: {
		handlers: {
			GET: notFound,
			POST: notFound,
			PATCH: notFound,
			DELETE: notFound,
		},
	},
});
