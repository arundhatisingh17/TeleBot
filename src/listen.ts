/**
 * Step 0: `npm run listen`
 *
 * Connects as you, watches incoming messages, prints them. Sends NOTHING.
 * Run this until you're confident it sees only what you expect.
 *
 * First run: leave PARTNER_ID blank. Have him send you a message. His ID
 * will be printed. Put it in .env, restart, and the filter goes live.
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage, type NewMessageEvent } from "teleproto/events/index.js";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH!;
const session = process.env.TELEGRAM_SESSION;
const partnerId = process.env.PARTNER_ID;

if (!apiId || !apiHash || !session) {
	console.error("Missing credentials. Run `npm run login` first.");
	process.exit(1);
}

const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
	connectionRetries: 5,
});
await client.connect();

const me = await client.getMe();
console.log(`Connected as ${me.username ?? me.firstName} (id ${me.id})`);
console.log(partnerId ? `Filtering to ${partnerId}` : "NO FILTER — discovery mode");

async function onMessage(event: NewMessageEvent) {
	const msg = event.message;

	// Guard 1: never react to your own messages. Without this, the bot reads
	// its own replies and loops forever inside your real chat.
	if (msg.out) return;

	// Guard 2: only the one chat this bot is allowed to touch.
	const senderId = msg.senderId?.toString();
	if (partnerId && senderId !== partnerId) return;

	console.log("---");
	console.log("from:", senderId);
	console.log("text:", msg.text || "(none)");
	console.log("media:", msg.media ? msg.media.className : "none");
}

// The library can filter too. Belt and suspenders: this narrows what even
// reaches the handler, and the handler re-checks anyway.
client.addEventHandler(
	onMessage,
	new NewMessage(partnerId ? { incoming: true, fromUsers: [partnerId] } : { incoming: true }),
);

console.log("Listening. Ctrl-C to stop.\n");
