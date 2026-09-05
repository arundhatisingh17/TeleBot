/**
 * Everything that knows about Telegram lives here. Nothing in this file is
 * imported by agent.ts, gifs.ts, or schedule.ts — dependency flows one way.
 */
import { Api, TelegramClient } from "teleproto";
import { generateRandomLong } from "teleproto/Helpers.js";
import { StringSession } from "teleproto/sessions/index.js";
import type { GifCandidate, GifSource } from "./gifs.js";

/** The official Telegram GIF search bot, backed by Tenor. */
const GIF_BOT = "gif";

export async function createClient(): Promise<TelegramClient> {
	const apiId = Number(process.env.TELEGRAM_API_ID);
	const apiHash = process.env.TELEGRAM_API_HASH!;
	const session = process.env.TELEGRAM_SESSION;
	if (!apiId || !apiHash || !session) {
		throw new Error("Missing Telegram credentials. Run `npm run login` first.");
	}
	const client = new TelegramClient(new StringSession(session), apiId, apiHash, { connectionRetries: 5 });
	await client.connect();
	return client;
}

/** What we need to remember about a search hit in order to send it later. */
interface InlineRef {
	queryId: unknown;
	id: string;
}

/**
 * GIF search via the @gif inline bot.
 *
 * `dryRun` prints instead of sending — leave it on until you trust the bot,
 * because the other end of this chat is a real person.
 */
export function createGifSource(client: TelegramClient, peer: string, dryRun: boolean): GifSource {
	return {
		async search(query, limit): Promise<GifCandidate[]> {
			const res: any = await client.invoke(
				new Api.messages.GetInlineBotResults({ bot: GIF_BOT, peer, query, offset: "" }),
			);

			const hits = (res.results ?? []).filter((r: any) => r.document).slice(0, limit);

			const candidates: GifCandidate[] = [];
			for (const hit of hits) {
				try {
					const buf = (await client.downloadMedia(hit.document)) as Buffer;
					if (buf?.length) {
						candidates.push({
							ref: { queryId: res.queryId, id: hit.id } satisfies InlineRef,
							title: hit.title ?? hit.description,
							mp4: buf,
						});
					}
				} catch {
					// One bad candidate shouldn't sink the whole search.
				}
			}
			return candidates;
		},

		async send(candidate) {
			const ref = candidate.ref as InlineRef;
			if (dryRun) {
				console.log(`  [DRY RUN — would send GIF ${ref.id}]`);
				return;
			}
			await client.invoke(
				new Api.messages.SendInlineBotResult({
					peer,
					queryId: ref.queryId as any,
					id: ref.id,
					randomId: generateRandomLong() as any,
					// Without this it shows "via @gif" — a giveaway that it's automated.
					hideVia: true,
				}),
			);
		},
	};
}

/**
 * Send a plain text message, or print it in dry-run mode.
 * Returns the sent message id so the caller can recognise its own output —
 * essential when testing against your own account.
 */
export async function sendText(
	client: TelegramClient,
	peer: string,
	text: string,
	dryRun: boolean,
): Promise<number | undefined> {
	if (dryRun) {
		console.log(`  [DRY RUN — would send text]: ${text}`);
		return undefined;
	}
	const sent: any = await client.sendMessage(peer, { message: text });
	return sent?.id;
}
