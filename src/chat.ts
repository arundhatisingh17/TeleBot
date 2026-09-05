/**
 * `npm run chat` — talk to the agent from your terminal. No Telegram, no login.
 *
 * This is how you develop the personality: iterate here where it's fast and
 * nobody's watching, then wire the same agent into the bot.
 *
 * Commands:
 *   /persona <id>   force a persona (bypasses the model's own choice)
 *   /who            print the active persona
 *   /exit
 */
import input from "input";
import { createAgent } from "./agent.js";

const { agent, send, getPersonaId, getBusyUntil, setPersonaId } = await createAgent();

console.log(`Persona: ${getPersonaId()}   (/persona <id>, /who, /exit)\n`);

// Print assistant text as it streams, so you can feel the latency.
agent.subscribe((event) => {
	if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
		process.stdout.write(event.assistantMessageEvent.delta);
	}
});

while (true) {
	const line = (await input.text("you: ")).trim();
	if (!line) continue;
	if (line === "/exit") break;
	if (line === "/who") {
		const until = getBusyUntil();
		console.log(`persona: ${getPersonaId()}${until ? ` | free ~${new Date(until).toLocaleTimeString()}` : ""}\n`);
		continue;
	}
	if (line.startsWith("/persona ")) {
		try {
			setPersonaId(line.slice(9).trim());
			console.log(`persona: ${getPersonaId()}\n`);
		} catch (err) {
			console.log((err as Error).message + "\n");
		}
		continue;
	}

	process.stdout.write("bot: ");
	await send(line);
	process.stdout.write("\n\n");
}

process.exit(0);
