// "Red zone, 3rd Down, #pass" -> ["red-zone", "3rd-down", "pass"]. Obsidian tags can't contain spaces or most
// symbols, and can't be only digits.
export function parseTags(input: string): string[] {
	const tags = input
		.split(",")
		.map((tag) =>
			tag
				.trim()
				.toLowerCase()
				.replace(/^#+/, "")
				.replace(/\s+/g, "-")
				.replace(/[^\p{L}\p{N}_/-]/gu, "")
		)
		.filter((tag) => tag && !/^\d+$/.test(tag));
	return [...new Set(tags)];
}

// How a tag is shown: "red-zone" -> "red zone".
export const tagLabel = (tag: string) => tag.replace(/-/g, " ");
