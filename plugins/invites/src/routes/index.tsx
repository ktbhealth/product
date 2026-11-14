import { useEffect, useState } from "react";

import { createPluginFileRoute } from "@ktb/server-fns";
import { Spinner } from "@ktbhealth/ui/components/spinner";

import { acceptInviteFn, invitePreviewFn, localeFn } from "../fns.ts";
import { inviteMessages } from "../i18n.ts";
import { AcceptInvitePage, type AcceptInviteApi, type AcceptInviteInvite } from "../views/index.ts";

/**
 * /invite#<token> — where the accept link of an invite email lands. A
 * live link lets the invitee choose a password and get in; a dead one
 * (unknown, used, expired) only points to sign-in.
 *
 * The token rides in the URL fragment on purpose: browsers never send
 * the fragment, so the credential stays out of request URLs — access
 * logs, traces, the Referer header. That is also why the invite is
 * resolved here in the browser, after hydration, and reaches the server
 * only in request bodies.
 */
export const Route = createPluginFileRoute("invites.routes")("/invite/")({
	loader: () => localeFn(),
	head: ({ loaderData }) => ({
		meta: [
			{ title: inviteMessages(loaderData ?? "en").metaTitle },
			{ name: "robots", content: "noindex" },
		],
	}),
	component: function AcceptInviteRoute() {
		const locale = Route.useLoaderData();
		const [link, setLink] = useState<{
			readonly token: string;
			readonly invite: AcceptInviteInvite | null;
		} | null>(null);
		useEffect(() => {
			const token = window.location.hash.slice(1);
			// A failed lookup reads as a dead link: the page can only offer
			// sign-in either way.
			void invitePreviewFn({ data: token }).then(
				(invite) => setLink({ token, invite }),
				() => setLink({ token, invite: null }),
			);
		}, []);
		if (link === null) {
			return (
				<div className="flex min-h-[60vh] items-center justify-center" role="status">
					<Spinner />
				</div>
			);
		}
		const api: AcceptInviteApi = {
			accept: (input) => acceptInviteFn({ data: { token: link.token, ...input } }),
		};
		return <AcceptInvitePage invite={link.invite} locale={locale} api={api} />;
	},
});
