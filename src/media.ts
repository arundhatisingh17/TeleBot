/**
 * Turning animations into stills.
 *
 * Telegram sends GIFs as silent MP4s, and Kimi only accepts still images.
 * So every GIF — his, or a search result — passes through here first.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Frame {
	type: "image";
	data: string; // base64
	mimeType: string;
}

/**
 * Sample `count` frames spread evenly across the animation.
 *
 * Why evenly rather than the first N: reaction GIFs usually have their payload
 * in the middle or at the end — the first N frames are often just a face
 * sitting still. Sampling across the whole thing catches the actual beat.
 */
export async function extractFrames(video: Buffer, count = 5): Promise<Frame[]> {
	const dir = await mkdtemp(join(tmpdir(), "telebot-"));
	try {
		const input = join(dir, "in.mp4");
		await writeFile(input, video);

		// fps filter can't space frames evenly without knowing the duration, so
		// ask ffprobe first.
		const { stdout } = await run("ffprobe", [
			"-v", "error",
			"-show_entries", "format=duration",
			"-of", "default=noprint_wrappers=1:nokey=1",
			input,
		]);
		const duration = Number.parseFloat(stdout.trim()) || 1;

		// Scale down: reaction GIFs are small and legible, and every pixel is
		// tokens you pay for.
		await run("ffmpeg", [
			"-v", "error",
			"-i", input,
			"-vf", `fps=${(count / duration).toFixed(4)},scale=320:-1`,
			"-frames:v", String(count),
			join(dir, "f%02d.jpg"),
		]);

		const files = (await readdir(dir)).filter((f) => f.endsWith(".jpg")).sort();
		return Promise.all(
			files.map(async (f) => ({
				type: "image" as const,
				data: (await readFile(join(dir, f))).toString("base64"),
				mimeType: "image/jpeg",
			})),
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/** True if ffmpeg and ffprobe are on PATH. Call once at startup. */
export async function hasFfmpeg(): Promise<boolean> {
	try {
		await run("ffprobe", ["-version"]);
		await run("ffmpeg", ["-version"]);
		return true;
	} catch {
		return false;
	}
}
