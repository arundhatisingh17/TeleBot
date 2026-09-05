/**
 * Run once: `npm run login`
 *
 * Logs into your Telegram account and prints a session string. Paste that
 * string into .env as TELEGRAM_SESSION and you never have to do this again.
 */
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import input from "input";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
	console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.");
	process.exit(1);
}

// An empty StringSession means "no saved login, start fresh".
const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
	connectionRetries: 5,
});

await client.start({
	phoneNumber: () => input.text("Phone number (with country code): "),
	password: () => input.text("2FA password (blank if none): "),
	phoneCode: () => input.text("Code Telegram just sent you: "),
	onError: (err) => console.error(err),
});

console.log("\nLogged in. Put this in your .env as TELEGRAM_SESSION:\n");
console.log(client.session.save());
console.log("\nThis is as sensitive as your password. Do not commit it.");

await client.disconnect();
process.exit(0);
