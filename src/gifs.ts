/**
 * Choosing a GIF by looking at it.
 *
 * The agent can only type a search phrase — it has no idea what Tenor will
 * return. So we search, download the top few, extract frames, and make a
 * separate vision call that actually *looks* at the candidates and picks.
 *
 * This file knows nothing about Telegram. The transport supplies a GifSource;
 * see the interface below.
 */
import { complete, type Model } from "@earendil-works/pi-ai";
import { extractFrames, type Frame } from "./media.js";
import { CONVERSATION_MODEL } from "./models.js";

/** One search hit. `ref` is opaque — only the transport that made it cares. */
export interface GifCandidate {
	ref: unknown;
	/** Whatever text the source knows about it, if any. Often absent. */
	title?: string;
	/** The animation itself, as an MP4. */
	mp4: Buffer;
}

/**
 * Implemented by the Telegram layer (and by a stub for terminal testing), so
 * the agent never imports teleproto. Dependency flows downward only.
 */
export interface GifSource {
	search(query: string, limit: number): Promise<GifCandidate[]>;
	send(candidate: GifCandidate): Promise<void>;
}

/** Frames per candidate when comparing. Kept low — this multiplies fast. */
const FRAMES_PER_CANDIDATE = 3;

/**
 * Show every candidate to the model and let it choose.
 * Returns the winning index, or 0 if the answer can't be parsed.
 */
export async function pickBestGif(
	query: string,
	candidates: GifCandidate[],
	model: Model<any> = CONVERSATION_MODEL,
): Promise<number> {
	if (candidates.length === 0) throw new Error("No candidates to pick from");
	if (candidates.length === 1) return 0;

	// Interleave a label before each candidate's frames, so the model can refer
	// to them by number. Without the labels it sees one undifferentiated pile.
	const content: (Frame | { type: "text"; text: string })[] = [];
	for (const [i, c] of candidates.entries()) {
		content.push({ type: "text", text: `--- Candidate ${i + 1}${c.title ? ` ("${c.title}")` : ""} ---` });
		content.push(...(await extractFrames(c.mp4, FRAMES_PER_CANDIDATE)));
	}
	content.push({
		type: "text",
		text: `These are ${candidates.length} animated GIFs, shown as frames in order. Someone wants to send one meaning: "${query}". Which fits best? Reply with the number only.`,
	});

	const response = await complete(model, {
		systemPrompt:
			"You judge whether a GIF conveys a feeling. Consider what actually happens across the frames, not just the first one. Answer with a single number.",
		messages: [{ role: "user", content: content as any, timestamp: Date.now() }],
	});

	const text = response.content
		.filter((c) => c.type === "text")
		.map((c) => (c as { text: string }).text)
		.join(" ");

	const n = Number.parseInt(text.match(/\d+/)?.[0] ?? "", 10);
	return Number.isFinite(n) && n >= 1 && n <= candidates.length ? n - 1 : 0;
}

/**
 * A GifSource that searches nothing and sends nothing — for `npm run chat`,
 * so you can develop the personality without Telegram connected.
 */
export const stubGifSource: GifSource = {
	async search(query) {
		console.log(`  [gif search: "${query}" — stub, no results]`);
		return [];
	},
	async send() {
		// Never called: search returns nothing.
	},
};
