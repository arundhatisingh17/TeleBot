/**
 * The bot. Wires transport (telegram.ts) to brain (agent.ts) and clock
 * (schedule.ts). This is the only file that imports all three.
 *
 * DRY_RUN=1 in .env prints replies instead of sending them. Keep it on until
 * you've watched it behave — the other end of this chat is a real person.
 */
import { NewMessage, type NewMessageEvent } from "teleproto/events/index.js";
import { createAgent } from "./agent.js";
import { extractFrames, hasFfmpeg } from "./media.js";
import { DEFAULT_PERSONA } from "./personas.js";
import { scheduleMorning } from "./schedule.js";
import { createClient, createGifSource, sendText } from "./telegram.js";

const configuredPartner = process.env.PARTNER_ID;
if (!configuredPartner) throw new Error("PARTNER_ID missing from .env — run `npm run listen` to find it.");

const dryRun = process.env.DRY_RUN !== "0";
if (!await hasFfmpeg()) throw new Error("ffmpeg not found — GIFs can't be read. `brew install ffmpeg`.");

const client = await createClient();
const me = await client.getMe();

/**
 * PARTNER_ID=me talks to your own Saved Messages for debugging. In that chat
 * every message is "outgoing", including the bot's own — so the usual `msg.out`
 * guard would ignore everything, and removing it would loop forever. Instead we
 * remember the ids we send and skip exactly those.
 */
const selfTest = configuredPartner === "me";
const partnerId = selfTest ? me.id.toString() : configuredPartner;
const ourMessageIds = new Set<number>();

// Backstop: if the loop-breaker ever fails, this stops the bleeding.
const RECENT_LIMIT = 8;
const RECENT_WINDOW_MS = 60_000;
let recent: number[] = [];
function runawayGuard(): boolean {
	const now = Date.now();
	recent = recent.filter((t) => now - t < RECENT_WINDOW_MS);
	recent.push(now);
	if (recent.length > RECENT_LIMIT) {
		console.error(`\n!! ${RECENT_LIMIT}+ replies in a minute — probable loop. Exiting.`);
		process.exit(1);
	}
	return true;
}

const gifSource = createGifSource(client, partnerId, dryRun);
const { agent, send, nudge, getLastInboundAt, setPersonaId, getPersonaId } = await createAgent(gifSource, "live");

console.log(`Connected as ${me.username ?? me.firstName}. Persona: ${getPersonaId()}`);
console.log(selfTest ? `SELF-TEST — talking to your own Saved Messages (${partnerId}).` : `Partner: ${partnerId}`);
console.log(dryRun ? "DRY RUN — nothing will actually be sent.\n" : "LIVE — messages will be sent.\n");

/**
 * Collect the assistant's text for a run, then send it as one message.
 *
 * We deliberately don't stream: Telegram rate-limits edits, and a reply that
 * visibly assembles itself word by word doesn't look like a person typing.
 */
let reply = "";
agent.subscribe(async (event) => {
	if (event.type === "message_end" && event.message.role === "assistant") {
		const text = event.message.content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		if (text) reply += (reply ? "\n" : "") + text;
	}
	// Surface tool failures — otherwise a throwing tool just looks like silence.
	if (event.type === "tool_execution_end" && (event as any).result?.isError) {
		console.error(`  [tool ${(event as any).toolName} failed]`, (event as any).result);
	}
	// A failed LLM call ends the run with no text. Without this it looks like
	// the bot simply chose not to reply.
	if (event.type === "message_end" && event.message.role === "assistant" && (event.message as any).stopReason === "error") {
		console.error(`  !! model error: ${(event.message as any).errorMessage ?? "unknown"}`);
	}
	if (event.type === "agent_end") {
		const out = reply.trim();
		reply = "";
		if (!out) console.log("  [no text produced — see above for tool activity or errors]");
		// A GIF-only reply is fine — send_gif already sent it.
		if (out) {
			const id = await sendText(client, partnerId, out, dryRun);
			if (id !== undefined) ourMessageIds.add(id);
		}
	}
});

async function onMessage(event: NewMessageEvent) {
	const msg = event.message;

	// Guard 1: never react to our own replies, or the bot talks to itself.
	// In self-test the sender is us, so we filter by message id instead.
	if (selfTest ? ourMessageIds.has(msg.id) : msg.out) return;
	// Guard 2: this chat only.
	if (msg.senderId?.toString() !== partnerId) return;

	runawayGuard();

	try {
		const media: any = msg.media;
		const doc = media?.document;
		const isAnimation = doc?.attributes?.some((a: any) => a.className === "DocumentAttributeAnimated");

		if (isAnimation) {
			// A GIF: sample frames so a still-image model can read it.
			console.log("< [gif]");
			const buf = (await client.downloadMedia(media)) as Buffer;
			const frames = await extractFrames(buf, 5);
			await send(
				`[He sent an animated GIF. These are ${frames.length} frames from it, in order. Read what it conveys and respond to it — usually with a GIF of your own.]${msg.text ? `\nHe also wrote: ${msg.text}` : ""}`,
				frames,
			);
		} else if (media?.photo) {
			console.log("< [photo]");
			const buf = (await client.downloadMedia(media)) as Buffer;
			await send(msg.text || "[He sent a photo.]", [
				{ type: "image", data: buf.toString("base64"), mimeType: "image/jpeg" },
			]);
		} else if (msg.text) {
			console.log(`< ${msg.text}`);
			await send(msg.text);
		} else {
			console.log("< [unsupported media, ignored]");
		}
	} catch (err) {
		// Never let one bad message kill the process.
		console.error("handler error:", err);
	}
}

// In self-test we must see outgoing messages too — they're the only kind
// there — so the library-level `incoming` filter has to come off.
client.addEventHandler(
	onMessage,
	selfTest ? new NewMessage({ chats: [partnerId] }) : new NewMessage({ incoming: true, fromUsers: [partnerId] }),
);

scheduleMorning({
	getLastInboundAt,
	onResetPersona: () => setPersonaId(DEFAULT_PERSONA),
	onSend: () => nudge("It is 9am and he hasn't texted yet. Send him a good morning."),
});

console.log("Listening. Ctrl-C to stop.\n");
