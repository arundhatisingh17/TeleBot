/**
 * Long-term memory: the handful of things that outlive the conversation window.
 *
 * Pruning history saves money but loses facts — "he's coming to San Diego in
 * March" would vanish once it scrolls off. So a cheap text-only model reads
 * each exchange and pulls out anything likely to be referenced later.
 *
 * Plans have a lifecycle: mentioned, referenced a few times, then done. A
 * resolved memory stops being injected so the prompt doesn't fill with history.
 */
import { readFile, writeFile } from "node:fs/promises";
import { complete } from "@earendil-works/pi-ai";
import { EXTRACTOR_MODEL } from "./models.js";

const memoryFileFor = (mode: "live" | "test") =>
	new URL(mode === "live" ? "../memory.json" : "../test-memory.json", import.meta.url);

/** Cheap and text-only — extraction never needs to see images. */
const EXTRACTOR = EXTRACTOR_MODEL;


/** How many active memories to inject. Keeps the prompt bounded. */
const MAX_ACTIVE = 12;

export interface Memory {
	id: string;
	/** One line, written so it still makes sense months later. */
	text: string;
	/** "plan" expires once it happens; "fact" is durable. */
	kind: "plan" | "fact";
	/** Free text — "March", "next weekend". Not parsed, just shown. */
	when?: string;
	createdAt: number;
	resolvedAt?: number;
}

export async function loadMemories(mode: "live" | "test" = "test"): Promise<Memory[]> {
	try {
		return JSON.parse(await readFile(memoryFileFor(mode), "utf-8"));
	} catch {
		return [];
	}
}

export async function saveMemories(memories: Memory[], mode: "live" | "test" = "test"): Promise<void> {
	await writeFile(memoryFileFor(mode), JSON.stringify(memories, null, 2));
}

export function activeMemories(all: Memory[]): Memory[] {
	return all.filter((m) => !m.resolvedAt).slice(-MAX_ACTIVE);
}

/** Rendered into the system prompt so the conversation model can use them. */
export function renderMemories(all: Memory[]): string {
	const active = activeMemories(all);
	if (active.length === 0) return "";
	return [
		"Things you already know. These are REFERENCE ONLY — do not raise any of them yourself, do not ask how they're going, and never recite them:",
		...active.map((m) => `- ${m.text}${m.when ? ` (${m.when})` : ""}`),
		"Use one only when HE brings that subject up first. Then react like someone who already knew — warm and looking forward to it ('ahh it's going to be so much fun'), not surprised and not repeating the details back to him.",
	].join("\n");
}

const SYSTEM = `You maintain a couple's shared memory. Read the latest exchange and decide what is worth remembering long-term.

RECORD only things likely to be referenced again:
- plans and commitments ("he's visiting San Diego in March", "dinner with his team Friday")
- durable facts (job, deadlines, people's names, preferences, ongoing projects)

DO NOT record: small talk, moods, one-off reactions, anything already in the existing list.

RESOLVE an existing memory when it has clearly happened, been cancelled, or is no longer relevant.

Reply with JSON only, no prose:
{"add":[{"text":"...","kind":"plan"|"fact","when":"optional"}],"resolve":["id"]}
Both arrays may be empty.`;

/**
 * Update memory from one exchange. Never throws — memory is a nice-to-have,
 * and a failed extraction must not break the reply that already went out.
 */
export async function updateMemories(
	existing: Memory[],
	exchange: { him: string; her: string },
): Promise<Memory[]> {
	try {
		const active = activeMemories(existing);
		const response = await complete(EXTRACTOR, {
			systemPrompt: SYSTEM,
			messages: [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: [
								active.length ? `Existing memories:\n${active.map((m) => `- [${m.id}] ${m.text}`).join("\n")}` : "Existing memories: none",
								"",
								`He said: ${exchange.him}`,
								`She replied: ${exchange.her}`,
							].join("\n"),
						},
					],
					timestamp: Date.now(),
				},
			],
		});

		const text = response.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { text: string }).text)
			.join("");

		// Models like to wrap JSON in prose or fences; take the outermost object.
		const json = text.match(/\{[\s\S]*\}/)?.[0];
		if (!json) return existing;

		const parsed = JSON.parse(json) as { add?: Partial<Memory>[]; resolve?: string[] };
		let next = [...existing];

		for (const id of parsed.resolve ?? []) {
			next = next.map((m) => (m.id === id && !m.resolvedAt ? { ...m, resolvedAt: Date.now() } : m));
		}

		for (const item of parsed.add ?? []) {
			if (!item.text) continue;
			next.push({
				id: Math.random().toString(36).slice(2, 8),
				text: item.text,
				kind: item.kind === "plan" ? "plan" : "fact",
				when: item.when,
				createdAt: Date.now(),
			});
		}

		return next;
	} catch (err) {
		console.error("  [memory] extraction failed:", (err as Error).message);
		return existing;
	}
}
