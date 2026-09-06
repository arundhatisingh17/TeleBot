import { readFile, writeFile } from "node:fs/promises";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { stream, Type } from "@earendil-works/pi-ai";
import { CONVERSATION_MODEL, sessionIdFor } from "./models.js";
import { type GifSource, pickBestGif, stubGifSource } from "./gifs.js";
import { loadMemories, type Memory, renderMemories, saveMemories, updateMemories } from "./memory.js";
import { withRetry } from "./retry.js";
import { chatDayKey } from "./schedule.js";
import {
	allowedTransitions,
	DEFAULT_PERSONA,
	getPersona,
	IDENTITY,
	personaRoster,
	validatePersonas,
} from "./personas.js";

/**
 * "live" is the real conversation; "test" is for `npm run chat` and scripts.
 * Separate files so experimenting never pollutes the real transcript or plants
 * fake memories in it.
 */
export type Mode = "live" | "test";

const stateFileFor = (mode: Mode) =>
	new URL(mode === "live" ? "../messages.json" : "../test-messages.json", import.meta.url);

/** How many recent GIFs keep their actual frames. Older ones become text. */
const KEEP_FRAMES_FOR_LAST_N_GIFS = 2;

/**
 * Strip image content from all but the most recent GIFs.
 *
 * This runs before every LLM call and changes only what is *sent* — the full
 * history stays on disk. Without it you re-upload every frame of every GIF he
 * has ever sent, on every single turn, forever.
 */
function pruneOldFrames(messages: any[]): any[] {
	const imageIndexes = messages
		.map((m, i) => (Array.isArray(m.content) && m.content.some((c: any) => c.type === "image") ? i : -1))
		.filter((i) => i >= 0);

	const keep = new Set(imageIndexes.slice(-KEEP_FRAMES_FOR_LAST_N_GIFS));

	return messages.map((m, i) => {
		if (!imageIndexes.includes(i) || keep.has(i)) return m;
		const images = m.content.filter((c: any) => c.type === "image").length;
		return {
			...m,
			content: [
				...m.content.filter((c: any) => c.type !== "image"),
				{ type: "text", text: `[${images} GIF frames from earlier — omitted to save context]` },
			],
		};
	});
}

interface Saved {
	activePersona: string;
	/** Which chat day this transcript belongs to, e.g. "2026-09-05". */
	dayKey?: string;
	/** When he last sent anything (epoch ms). Undefined if he never has. */
	lastInboundAt?: number;
	personaSince: number;
	busyUntil?: number;
	messages: unknown[];
}

const fmt = (ms: number) =>
	new Date(ms).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });

function describeMinutes(mins: number): string {
	if (mins < 1) return "just now";
	if (mins < 60) return `${Math.round(mins)} min ago`;
	const h = mins / 60;
	if (h < 24) return `${h.toFixed(h < 10 ? 1 : 0)} hours ago`;
	return `${Math.round(h / 24)} days ago`;
}

/** Persona prompt + roster + clock. Rebuilt on every send, so "now" stays true. */
function buildSystemPrompt(personaId: string, since: number, busyUntil: number | undefined, memories: Memory[]): string {
	const persona = getPersona(personaId) ?? getPersona(DEFAULT_PERSONA)!;
	const now = Date.now();

	const clock = [`Right now it is ${fmt(now)}.`, `You have been "${persona.id}" since ${fmt(since)} (${describeMinutes((now - since) / 60000)}).`];

	if (busyUntil !== undefined) {
		const minsLeft = (busyUntil - now) / 60000;
		clock.push(
			minsLeft > 0
				? `He expected to be free around ${fmt(busyUntil)} — about ${Math.round(minsLeft)} min from now. Do not chase him before then.`
				: `He expected to be free around ${fmt(busyUntil)}, which has now passed. It is reasonable to check in gently.`,
		);
	} else if (persona.id === "busy") {
		clock.push("He gave no estimate of when he'd be free. Tell him you'll wait for his text rather than guessing a time.");
	}

	return [
		// Identity first: constant across personas. The persona prompt below
		// only changes the register, never who she is.
		IDENTITY,
		"",
		persona.systemPrompt,
		"",
		clock.join(" "),
		renderMemories(memories),
		"",
		`You are currently "${persona.id}".`,
		persona.exitWhen ? `Leave this persona when: ${persona.exitWhen}` : "",
		"",
		"You may call switch_persona to move to one of these, and only these:",
		personaRoster(persona.id),
		"",
		"Switch only when the conversation clearly calls for it — not every message.",
		"After switching, answer in the new voice in the same reply.",
		"Never mention personas or switching out loud.",
	]
		.filter(Boolean)
		.join("\n");
}

export async function createAgent(gifSource: GifSource = stubGifSource, mode: Mode = "test") {
	validatePersonas();

	const STATE_FILE = stateFileFor(mode);

	// Restore prior conversation if there is one.
	let saved: Saved = { activePersona: DEFAULT_PERSONA, personaSince: Date.now(), messages: [] };
	try {
		saved = JSON.parse(await readFile(STATE_FILE, "utf-8"));
	} catch {
		// No state file yet — first run.
	}

	// Chat days run 07:00 to 02:00 NY. On a new day the transcript is flushed —
	// safe precisely because memory.json has already captured anything durable.
	const dayKey = chatDayKey();
	if (saved.dayKey && saved.dayKey !== dayKey) {
		console.log(`[day] new chat day ${dayKey} (was ${saved.dayKey}) — clearing ${saved.messages.length} messages`);
		saved.messages = [];
		saved.activePersona = DEFAULT_PERSONA;
		saved.busyUntil = undefined;
	}

	let activePersona = saved.activePersona;
	let personaSince = saved.personaSince ?? Date.now();
	let busyUntil = saved.busyUntil;
	let lastInboundAt = saved.lastInboundAt;
	let memories = await loadMemories(mode);
	// Set on each send so the extractor knows what he actually said.
	let lastHim = "";

	const refreshPrompt = () => {
		agent.state.systemPrompt = buildSystemPrompt(activePersona, personaSince, busyUntil, memories);
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: buildSystemPrompt(activePersona, personaSince, busyUntil, memories),
			model: CONVERSATION_MODEL,
			messages: saved.messages as any,
		},
		// Runs before every LLM call. Affects what's sent, never what's stored.
		transformContext: async (messages) => pruneOldFrames(messages as any[]) as any,
		// Lets the provider bill repeated history at the cache-read rate
		// (~6x cheaper) instead of re-charging full price every turn.
		sessionId: sessionIdFor(mode, dayKey),
		// pi-agent-core's default stream function returns a bodiless 400 against
		// Hugging Face's router; pi-ai's own `stream` works. Verified 3/3 vs 0/3.
		streamFn: (model, context, options) => stream(model, context, options as any),
	});

	// The tool closes over `agent`, so switching is just reassigning state.
	// History is deliberately NOT cleared: the tool result stays in the
	// transcript, so the model can see when and why the voice changed.
	const switchSchema = Type.Object({
		persona: Type.String({ description: "The persona id to switch to" }),
		reason: Type.String({ description: "Briefly, why this fits right now" }),
		freeInMinutes: Type.Optional(
			Type.Number({
				description:
					"Only when switching to busy AND he gave a time estimate ('an hour', 'back by 5'). Minutes from now. Omit if he gave no estimate.",
			}),
		),
	});

	const switchPersona: AgentTool<typeof switchSchema> = {
		name: "switch_persona",
		label: "Switch persona",
		description: "Change the voice you respond in. Use sparingly.",
		parameters: switchSchema,
		execute: async (_id, params) => {
			const next = getPersona(params.persona);
			if (!next) throw new Error(`No such persona: ${params.persona}`);

			// Enforce the transition rules. Throwing surfaces to the model as a
			// tool error, so it can recover and pick a legal target instead.
			const legal = allowedTransitions(activePersona).map((p) => p.id);
			if (!legal.includes(next.id)) {
				throw new Error(
					`Cannot switch from "${activePersona}" to "${next.id}". Allowed: ${legal.join(", ") || "none"}`,
				);
			}

			activePersona = next.id;
			personaSince = Date.now();
			busyUntil =
				next.id === "busy" && params.freeInMinutes !== undefined
					? Date.now() + params.freeInMinutes * 60000
					: undefined;
			refreshPrompt();

			console.log(`  [persona → ${next.id}: ${params.reason}${busyUntil ? ` | free ~${fmt(busyUntil)}` : ""}]`);

			return {
				content: [
					{
						type: "text",
						text: busyUntil
							? `Now speaking as "${next.id}". He should be free around ${fmt(busyUntil)} — say you'll check back around then.`
							: `Now speaking as "${next.id}". Continue in this voice.`,
					},
				],
				details: { persona: next.id, busyUntil },
			};
		},
	};

	// How many search hits to actually look at. More = better picks, more cost.
	const GIF_CANDIDATES = 5;

	const gifSchema = Type.Object({
		query: Type.String({
			description:
				"What the GIF should convey, as a search phrase — e.g. 'excited happy dance', 'tired done with everything'. Describe the feeling, not the words you'd say.",
		}),
	});

	const sendGif: AgentTool<typeof gifSchema> = {
		name: "send_gif",
		label: "Send GIF",
		description:
			"Reply with an animated GIF instead of, or alongside, text. You two mostly talk in GIFs, so reach for this often.",
		parameters: gifSchema,
		execute: async (_id, params) => {
			const candidates = await gifSource.search(params.query, GIF_CANDIDATES);
			if (candidates.length === 0) {
				throw new Error(`No GIFs found for "${params.query}". Reply with text instead.`);
			}

			// The agent picked a search phrase blind; this call actually looks.
			const best = await pickBestGif(params.query, candidates);
			await gifSource.send(candidates[best]);

			console.log(`  [gif sent: "${params.query}" → candidate ${best + 1}/${candidates.length}]`);
			return {
				content: [{ type: "text", text: `GIF sent. Add a short line of text only if it adds something.` }],
				details: { query: params.query, picked: best },
			};
		},
	};

	agent.state.tools = [switchPersona, sendGif];

	// Persist after every completed run so a crash or restart keeps the thread.
	agent.subscribe(async (event) => {
		if (event.type === "agent_end") {
			// Recompute the key: a long-running process crosses 07:00.
			const state: Saved = { activePersona, dayKey: chatDayKey(), personaSince, busyUntil, lastInboundAt, messages: agent.state.messages };
			await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

			// Pull durable facts out of the exchange before it scrolls away.
			const her = ([...agent.state.messages] as any[])
				.reverse()
				.find((m) => m.role === "assistant")
				?.content?.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("")
				.trim();

			if (lastHim && her) {
				const before = memories.length;
				memories = await updateMemories(memories, { him: lastHim, her });
				const added = memories.slice(before);
				if (added.length) console.log(`  [memory +${added.length}] ${added.map((m) => m.text).join(" | ")}`);
				await saveMemories(memories, mode);
				refreshPrompt();
			}
		}
	});

	/**
	 * Prompt, and retry if the model call errors.
	 *
	 * A failed run leaves the user message and a failed assistant message in
	 * context. Both are rolled back before retrying, so a retry re-sends a
	 * clean prompt rather than stacking failures in the transcript.
	 */
	async function promptWithRetry(text: string, images?: { type: "image"; data: string; mimeType: string }[]) {
		const snapshot = agent.state.messages.length;

		await withRetry(async () => {
			refreshPrompt();
			await agent.prompt(text, images);

			const last = agent.state.messages.at(-1) as any;
			const failed = (agent.state.messages as any[]).some(
				(m, i) => i >= snapshot && m.role === "assistant" && m.stopReason === "error",
			);
			if (!failed) return undefined;

			const message = (last?.errorMessage as string) ?? agent.state.errorMessage ?? "unknown model error";
			agent.state.messages = agent.state.messages.slice(0, snapshot); // roll back
			return message;
		}, "reply");
	}

	return {
		agent,
		/**
		 * Use this instead of agent.prompt() — it refreshes the clock first.
		 * `images` carries photo data or GIF frames.
		 */
		send: async (text: string, images?: { type: "image"; data: string; mimeType: string }[]) => {
			lastInboundAt = Date.now();
			lastHim = text;
			await promptWithRetry(text, images);
		},
		/**
		 * Wake the agent with no incoming message. The instruction is written as
		 * a stage direction, not as something he said — so the model acts on it
		 * without thinking he spoke.
		 */
		nudge: async (instruction: string) => {
			await promptWithRetry(`[No message from him. ${instruction} Write only what you'd send — no preamble.]`);
		},
		getPersonaId: () => activePersona,
		getBusyUntil: () => busyUntil,
		getLastInboundAt: () => lastInboundAt,
		/** Force a persona while testing, without tricking the model into picking it. */
		setPersonaId: (id: string) => {
			if (!getPersona(id)) throw new Error(`No such persona: ${id}`);
			activePersona = id;
			personaSince = Date.now();
			busyUntil = undefined;
			refreshPrompt();
		},
	};
}
