/**
 * `npm run whois` — list your recent chats with their IDs, and check whether
 * PARTNER_ID resolves.
 *
 * Telegram can only resolve a user id you've actually interacted with; a bare
 * number from nowhere fails with 400 PEER_ID_INVALID. Pick his id from here.
 */
import { createClient } from "./telegram.js";

const client = await createClient();
const me = await client.getMe();
console.log(`You: ${me.username ?? me.firstName} (${me.id})\n`);

const partnerId = process.env.PARTNER_ID;
if (partnerId && partnerId !== "me") {
	try {
		const them: any = await client.getEntity(partnerId);
		const name = [them.firstName, them.lastName].filter(Boolean).join(" ") || them.username;
		console.log(`PARTNER_ID ${partnerId} resolves to: ${name}\n`);
	} catch (err) {
		console.log(`PARTNER_ID ${partnerId} DOES NOT RESOLVE: ${(err as Error).message}\n`);
	}
}

console.log("Recent private chats:");
for await (const dialog of client.iterDialogs({ limit: 30 })) {
	const e: any = dialog.entity;
	if (e?.className !== "User" || e.bot) continue;
	const name = [e.firstName, e.lastName].filter(Boolean).join(" ") || "(no name)";
	console.log(`  ${String(e.id).padEnd(14)} ${name}${e.username ? ` @${e.username}` : ""}`);
}

await client.disconnect();
process.exit(0);
