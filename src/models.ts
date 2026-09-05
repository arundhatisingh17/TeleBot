/**
 * Model choices in one place, so they can't drift apart.
 *
 * Prices per million tokens (input / output / cache-read):
 *   Kimi K2.5        0.60 / 3.00 / 0.10   vision  <- conversation + gif picking
 *   Kimi K2.6        0.95 / 4.00 / 0.16   vision
 *   Kimi K2-Instruct 1.00 / 3.00 / —      text    <- memory extraction
 *
 * Cache reads are ~6x cheaper than fresh input, which is why sessionId matters
 * far more than the model choice: history is re-sent on every single turn.
 */
import { getModel } from "@earendil-works/pi-ai";

/** Replies and GIF picking. Must be vision-capable. */
export const CONVERSATION_MODEL = getModel("huggingface", "moonshotai/Kimi-K2.5");

/** Memory extraction. Text-only is fine and never needs to see frames. */
export const EXTRACTOR_MODEL = getModel("huggingface", "moonshotai/Kimi-K2-Instruct");

/**
 * Providers cache on a stable prefix keyed by session. Ours is per chat-day:
 * the transcript is flushed each morning anyway, so a new day legitimately
 * starts a new cache, and every turn within the day reuses it.
 */
export const sessionIdFor = (mode: string, dayKey: string) => `telebot-${mode}-${dayKey}`;
