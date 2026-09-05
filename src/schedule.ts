/**
 * Things that happen on a clock rather than in response to a message.
 *
 * Knows nothing about Telegram or the agent — it takes callbacks. That keeps
 * the scheduling logic testable without sending anything to anyone.
 */
import { Cron } from "croner";

export const TIMEZONE = "America/New_York";
export const MORNING_CRON = "0 9 * * *"; // 09:00 daily

/**
 * When a new day starts for "has he texted yet" purposes. 5am, not midnight —
 * a 2am message is last night's conversation, not this morning's greeting.
 */
export const DAY_START_HOUR = 5;

/**
 * When the *chat day* rolls over for history purposes. Conversation runs
 * 07:00 through 02:00 the next morning; at 07:00 the transcript is flushed and
 * a new day starts. Anything sent in the 02:00-07:00 gap still belongs to the
 * night before, so it survives until the 07:00 flush.
 */
export const CHAT_DAY_START_HOUR = 7;

/**
 * Identifies the current chat day, e.g. "2026-09-05". Compare the stored key
 * with a fresh one — if they differ, the transcript is from a previous day.
 */
export function chatDayKey(tz = TIMEZONE, now = new Date()): string {
	const midnight = startOfDayIn(tz, now);
	// Before the 07:00 boundary we're still in yesterday's chat day.
	const dayStart = now.getTime() >= midnight + CHAT_DAY_START_HOUR * 3600000 ? midnight : midnight - 24 * 3600000;
	return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
		.format(new Date(dayStart + 12 * 3600000)); // midday avoids DST edge cases
}

/** Midnight today in `tz`, as epoch ms. Handles DST via Intl, not by guessing. */
export function startOfDayIn(tz: string, now = new Date()): number {
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).formatToParts(now);

	const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
	// How far into the local day we are, subtracted from the real instant.
	const msIntoDay = (get("hour") % 24) * 3600000 + get("minute") * 60000 + get("second") * 1000;
	return now.getTime() - msIntoDay - (now.getTime() % 1000);
}

/**
 * Start of the current *waking* day: today at DAY_START_HOUR, or yesterday's
 * if we haven't reached it yet (i.e. it's 3am and still "last night").
 */
export function startOfWakingDay(tz = TIMEZONE, now = new Date()): number {
	const boundary = startOfDayIn(tz, now) + DAY_START_HOUR * 3600000;
	return now.getTime() >= boundary ? boundary : boundary - 24 * 3600000;
}

/** Has he sent anything since 5am New York time? */
export function hasTextedToday(lastInboundAt: number | undefined, tz = TIMEZONE, now = new Date()): boolean {
	if (lastInboundAt === undefined) return false;
	return lastInboundAt >= startOfWakingDay(tz, now);
}

export interface MorningJobOptions {
	/** Last time he sent anything — read fresh at fire time, not captured. */
	getLastInboundAt: () => number | undefined;
	/**
	 * Called before onSend. Yesterday may have ended in `wary` or `busy`, and a
	 * 9am greeting in either of those voices reads badly — reset to default.
	 */
	onResetPersona: () => void;
	/** Called only when he hasn't texted yet today. */
	onSend: () => Promise<void>;
	timezone?: string;
	cron?: string;
}

/**
 * Fire a good-morning at 09:00 NY, but only if he hasn't spoken yet today.
 * If he already texted, we'd have replied reactively — no need to greet twice.
 */
export function scheduleMorning(opts: MorningJobOptions): Cron {
	const tz = opts.timezone ?? TIMEZONE;

	const job = new Cron(opts.cron ?? MORNING_CRON, { timezone: tz, protect: true }, async () => {
		if (hasTextedToday(opts.getLastInboundAt(), tz)) {
			console.log("[morning] he already texted today — skipping");
			return;
		}
		console.log("[morning] sending good morning");
		try {
			opts.onResetPersona();
			await opts.onSend();
		} catch (err) {
			// A failed greeting must not kill the process — tomorrow still runs.
			console.error("[morning] failed:", (err as Error).message);
		}
	});

	console.log(`[morning] scheduled ${opts.cron ?? MORNING_CRON} ${tz} — next: ${job.nextRun()?.toLocaleString()}`);
	return job;
}
