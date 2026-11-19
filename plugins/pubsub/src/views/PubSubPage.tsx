import { useState } from "react";

import { sliceMessages } from "@ktb/i18n";
import type { PageI18nSlice } from "@ktb/kernel";
import type { PubSubTopicInfo, PubSubTopicsResult } from "@ktb/server-fns";
import { Button } from "@ktbhealth/ui/components/button";
import { Input } from "@ktbhealth/ui/components/input";
import { Textarea } from "@ktbhealth/ui/components/textarea";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@ktbhealth/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ktbhealth/ui/components/tabs";

import { publishPubSubMessageFn } from "../fns.ts";
import { I18N_NAMESPACE, pubSubMessages, type PubSubMessages } from "../i18n.ts";
import type { PubSubPublishResult } from "../admin.ts";

/**
 * /platform/pubsub — the Concurrency console page. Two sections:
 * topics (every channel the bound transports enumerate, with honest
 * subscriber/history states plus a degraded-source banner) and
 * publish (a manual JSON publish to a topic id). Every signal
 * degrades to the unavailable state.
 */

interface PubSubPageProps {
	/** Merged topic listing; null when the sources cannot be read at
	 * all. `degraded` names bound sources whose probe failed. */
	readonly listing: PubSubTopicsResult | null;
	/** DB catalog slice for this route's namespaces (PL-008). */
	readonly i18n?: PageI18nSlice;
	readonly locale: string;
}

const fmt = (ts: number | null | undefined, locale: string) =>
	ts === null || ts === undefined
		? "—"
		: new Date(ts).toLocaleString(locale, { dateStyle: "short", timeStyle: "medium" });

const lastActivity = (topic: PubSubTopicInfo): number | null =>
	topic.recent === undefined || topic.recent.length === 0
		? null
		: topic.recent[topic.recent.length - 1]!.at;

const Unavailable = ({ m }: { m: PubSubMessages }) => (
	<div className="border-border rounded-md border px-4 py-6 text-sm">
		<span className="font-medium">{m.unavailableTitle}</span>
		<span className="text-muted-foreground"> — {m.unavailableDescription}</span>
	</div>
);

const publishMessage = (result: PubSubPublishResult, m: PubSubMessages): string => {
	if (result.ok) return m.publishOk;
	switch (result.reason) {
		case "unknown-topic":
			return m.publishUnknown;
		case "unavailable":
			return m.publishUnavailable;
		case "forbidden":
			return m.publishForbidden;
		default:
			return m.publishFailed;
	}
};

function TopicsSection({
	listing,
	locale,
	m,
}: {
	listing: PubSubTopicsResult | null;
	locale: string;
	m: PubSubMessages;
}) {
	const topics = listing?.topics ?? null;
	return (
		<section>
			<h2 className="text-sm font-semibold">{m.topicsTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.topicsDescription}</p>
			{listing !== null && listing.degraded.length > 0 && (
				<div className="border-warning/30 bg-warning/10 mb-3 rounded-md border px-4 py-3 text-sm text-warning">
					<span className="font-medium">{m.degradedTitle}</span>
					<span className="text-muted-foreground">
						{" — "}
						{m.degradedDescription(listing.degraded.join(", "))}
					</span>
				</div>
			)}
			{topics === null ? (
				<Unavailable m={m} />
			) : topics.length === 0 ? (
				<div className="border-border text-muted-foreground rounded-md border px-4 py-6 text-sm">
					{m.emptyTopicsTitle} — {m.emptyTopicsDescription}
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>{m.tColTopic}</TableHead>
							<TableHead>{m.tColTransport}</TableHead>
							<TableHead>{m.tColSubscribers}</TableHead>
							<TableHead>{m.tColRecent}</TableHead>
							<TableHead>{m.tColLastActivity}</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{topics.map((topic) => {
							const last = lastActivity(topic);
							return (
								<TableRow key={topic.id}>
									<TableCell>
										<div className="flex flex-col">
											<span className="font-medium">{topic.name}</span>
											<code className="text-muted-foreground text-xs">{topic.id}</code>
										</div>
									</TableCell>
									<TableCell className="text-xs">{topic.transport}</TableCell>
									<TableCell className="text-xs whitespace-nowrap">
										{topic.subscribers === null ? m.subscribersUnknown : topic.subscribers}
									</TableCell>
									<TableCell className="text-xs whitespace-nowrap">
										{topic.recent === undefined
											? m.subscribersUnknown
											: topic.recent.length === 0
												? m.noRecent
												: topic.recent.length}
									</TableCell>
									<TableCell className="text-xs whitespace-nowrap">
										{topic.recent === undefined ? (
											// No retained history — activity is unknown,
											// not "never".
											<span className="text-muted-foreground">{m.subscribersUnknown}</span>
										) : last === null ? (
											<span className="text-muted-foreground">{m.neverActive}</span>
										) : (
											fmt(last, locale)
										)}
									</TableCell>
								</TableRow>
							);
						})}
					</TableBody>
				</Table>
			)}
		</section>
	);
}

function PublishSection({ m }: { m: PubSubMessages }) {
	const [topicId, setTopicId] = useState("");
	const [raw, setRaw] = useState('{"hello":"world"}');
	const [state, setState] = useState<{
		readonly pending: boolean;
		readonly message: string | null;
		readonly ok: boolean;
	}>({ pending: false, message: null, ok: false });

	const submit = async () => {
		let payload: unknown;
		try {
			payload = JSON.parse(raw);
		} catch {
			setState({ pending: false, message: m.invalidJson, ok: false });
			return;
		}
		setState({ pending: true, message: null, ok: false });
		try {
			const result = await publishPubSubMessageFn({
				data: { topicId: topicId.trim(), payload },
			});
			setState({ pending: false, message: publishMessage(result, m), ok: result.ok });
		} catch {
			setState({ pending: false, message: m.publishFailed, ok: false });
		}
	};

	return (
		<section>
			<h2 className="text-sm font-semibold">{m.publishTitle}</h2>
			<p className="text-muted-foreground mb-3 text-xs">{m.publishDescription}</p>
			<div className="border-border flex max-w-xl flex-col gap-3 rounded-md border p-4">
				<label className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{m.pTopic}</span>
					<Input
						value={topicId}
						onChange={(e) => setTopicId(e.target.value)}
						placeholder={m.pTopicPlaceholder}
					/>
				</label>
				<label className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{m.pPayload}</span>
					<Textarea
						value={raw}
						onChange={(e) => setRaw(e.target.value)}
						rows={4}
						className="font-mono text-xs"
					/>
					<span className="text-muted-foreground text-xs">{m.pPayloadHint}</span>
				</label>
				<div className="flex items-center gap-3">
					<Button
						size="sm"
						disabled={state.pending || topicId.trim() === ""}
						onClick={() => void submit()}
					>
						{state.pending ? m.publishing : m.publish}
					</Button>
					{state.message !== null && (
						<span className={`text-xs ${state.ok ? "text-success" : "text-destructive"}`}>
							{state.message}
						</span>
					)}
				</div>
			</div>
		</section>
	);
}

export function PubSubPage({ listing, i18n, locale }: PubSubPageProps) {
	const m = sliceMessages(i18n, I18N_NAMESPACE, pubSubMessages(locale));
	const count = listing?.topics.length ?? null;
	return (
		<div className="mx-auto flex max-w-5xl flex-col gap-8 p-6">
			<header>
				<h1 className="text-2xl font-semibold tracking-tight">{m.title}</h1>
				<p className="text-muted-foreground mt-1 text-sm">
					{count === null ? m.unavailableDescription : m.description(count)}
				</p>
			</header>
			<Tabs defaultValue="topics">
				<TabsList>
					<TabsTrigger value="topics">{m.topicsTitle}</TabsTrigger>
					<TabsTrigger value="publish">{m.publishTitle}</TabsTrigger>
				</TabsList>
				<TabsContent value="topics">
					<TopicsSection listing={listing} locale={locale} m={m} />
				</TabsContent>
				<TabsContent value="publish">
					<PublishSection m={m} />
				</TabsContent>
			</Tabs>
		</div>
	);
}
