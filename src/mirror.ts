import type { DrawingElement } from "./formations";

const SWAP: Record<string, string> = { right: "left", left: "right", rt: "lt", lt: "rt" };

// Swaps right/left (and rt/lt) words, keeping their capitalization: "Trips Right" -> "Trips Left".
export function swapSides(text: string): string {
	return text.replace(/\b(right|left|rt|lt)\b/gi, (word) => {
		const swapped = SWAP[word.toLowerCase()];
		if (word === word.toUpperCase()) return swapped.toUpperCase();
		return word[0] === word[0].toUpperCase() ? swapped[0].toUpperCase() + swapped.slice(1) : swapped;
	});
}

export function mirroredName(name: string): string {
	const swapped = swapSides(name);
	return swapped === name ? `${name} (mirrored)` : swapped;
}

// Mirrored copy of a play note: swaps left/right wording in the body, points the embed at the new drawing and retitles
// it. In the frontmatter only the ball position changes sides.
export function mirrorNote(text: string, oldDrawing: string, newDrawing: string, oldName: string, name: string): string {
	const end = text.startsWith("---\n") ? text.indexOf("\n---", 4) + 4 : 0;
	const frontmatter = text
		.slice(0, end)
		.split("\n")
		.map((line) => (line.startsWith("ball:") ? swapSides(line) : line));
	const body = text
		.slice(end)
		.split("\n")
		.map((line) => {
			if (line.includes("![[")) return line.split(oldDrawing).join(newDrawing);
			return line === `# ${oldName}` ? `# ${name}` : swapSides(line);
		});
	return frontmatter.join("\n") + body.join("\n");
}

// Flips drawing elements left-right around the middle of the field (x = 0). Returns new objects.
export function mirrorElements<T extends DrawingElement>(elements: T[]): T[] {
	const flip = (b: DrawingElement["startBinding"]) =>
		b && {
			...b,
			...(typeof b.focus === "number" && { focus: -b.focus }),
			...(b.fixedPoint && { fixedPoint: [1 - b.fixedPoint[0], b.fixedPoint[1]] as [number, number] }),
		};
	return elements.map((e) => ({
		...e,
		// Lines, arrows and freehand strokes are an origin plus relative points; everything else is a box.
		...(e.points ? { x: -e.x, points: e.points.map(([px, py]) => [-px, py]) } : { x: -(e.x + e.width) }),
		...(e.angle && { angle: (2 * Math.PI - e.angle) % (2 * Math.PI) }),
		...(e.startBinding && { startBinding: flip(e.startBinding) }),
		...(e.endBinding && { endBinding: flip(e.endBinding) }),
	}));
}
