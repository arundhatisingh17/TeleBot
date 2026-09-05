// `input` ships no types; we only use input.text().
declare module "input" {
	const input: { text(prompt: string): Promise<string> };
	export default input;
}
