/**
 * Retrying failed model calls.
 *
 * A failed LLM call ends the run with no text, which in a real chat looks like
 * being ignored. Transient failures (rate limits, network blips, provider
 * hiccups) deserve a retry.
 *
 * But some failures need a human: 402 means credits are gone and no amount of
 * retrying fixes it. So we back off aggressively and give up after a budget —
 * a reply that lands an hour late is worse than none at all.
 */

/** Wait this long between attempts, growing until the cap. */
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 120_000;

/** Give up after this much wall-clock time across all attempts. */
export const RETRY_BUDGET_MS = 10 * 60_000;

/** True for errors that a retry could plausibly fix. */
export function isRetryable(message: string): boolean {
	// A 400 with no body is a gateway hiccup, not a validation error — a real
	// bad request comes back with an explanation. Retry those; a 400 that does
	// carry a body means we sent something wrong and retrying won't help.
	if (/400 status code \(no body\)/i.test(message)) return true;

	// 402 = out of credits. Retryable only in the sense that topping up fixes
	// it — which is why the budget exists.
	return /\b(402|429|500|502|503|504)\b|rate.?limit|timeout|ECONN|network|overloaded/i.test(message);
}

export function describeError(message: string): string {
	if (/\b402\b/.test(message)) return "out of credits (402) — top up at huggingface.co/settings/billing";
	if (/\b429\b|rate.?limit/i.test(message)) return "rate limited (429)";
	return message.slice(0, 200);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run `attempt` until it reports success or the budget runs out.
 * `attempt` returns an error message, or undefined on success.
 */
export async function withRetry(
	attempt: () => Promise<string | undefined>,
	label = "model call",
	budgetMs = RETRY_BUDGET_MS,
): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	let delay = BASE_DELAY_MS;
	let tries = 0;

	while (true) {
		tries++;
		const error = await attempt();
		if (!error) return true;

		if (!isRetryable(error)) {
			console.error(`  !! ${label} failed (not retryable): ${describeError(error)}`);
			return false;
		}

		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			console.error(`  !! ${label} gave up after ${tries} tries: ${describeError(error)}`);
			return false;
		}

		const wait = Math.min(delay, MAX_DELAY_MS, remaining);
		console.warn(`  .. ${label} failed (${describeError(error)}) — retry ${tries} in ${Math.round(wait / 1000)}s`);
		await sleep(wait);
		delay = Math.min(delay * 3, MAX_DELAY_MS);
	}
}
