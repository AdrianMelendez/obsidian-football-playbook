// Checks mirroring of names, notes and drawing elements.
import assert from "node:assert";
import { mirrorElements, mirrorNote, mirroredName, swapSides } from "../src/mirror.ts";

assert.equal(mirroredName("Shotgun Trips Right"), "Shotgun Trips Left");
assert.equal(mirroredName("deuce rt hitches"), "deuce lt hitches");
assert.equal(mirroredName("BUNCH LEFT"), "BUNCH RIGHT");
assert.equal(mirroredName("Spread 2x2"), "Spread 2x2 (mirrored)");
assert.equal(swapSides("Brighton alright, cleft"), "Brighton alright, cleft"); // whole words only

const note = [
	"---",
	'formation: "Trips Right"',
	"---",
	"# deuce rt hitches",
	"*Offense · Trips Right*",
	"",
	"![[P/Trips Right/deuce rt hitches.excalidraw.md|700]]",
	"| T left | Block right |",
].join("\n");
assert.equal(
	mirrorNote(note, "P/Trips Right/deuce rt hitches.excalidraw.md", "P/Trips Right/Deuce left.excalidraw.md", "deuce rt hitches", "Deuce left"),
	[
		"---",
		'formation: "Trips Right"', // frontmatter untouched
		"---",
		"# Deuce left", // retitled with the chosen name
		"*Offense · Trips Left*",
		"",
		"![[P/Trips Right/Deuce left.excalidraw.md|700]]", // embed points at the new drawing
		"| T right | Block left |",
	].join("\n")
);

const rect = { type: "ellipse", x: 10, y: 5, width: 20, height: 20 };
const arrow = {
	type: "arrow", x: 30, y: 0, width: 40, height: 10, points: [[0, 0], [40, -10]] as [number, number][],
	startBinding: { focus: 0.3, fixedPoint: [0.25, 0.5] as [number, number] },
	endBinding: null,
};
const [mRect, mArrow] = mirrorElements([rect, arrow]);
assert.equal(mRect.x, -30); // box 10..30 becomes -30..-10
assert.deepEqual(mArrow.points, [[-0, 0], [-40, -10]]);
assert.equal(mArrow.x, -30);
assert.deepEqual(mArrow.startBinding, { focus: -0.3, fixedPoint: [0.75, 0.5] });
assert.equal(mArrow.endBinding, null);
assert.deepEqual(mirrorElements(mirrorElements([rect, arrow])), [rect, arrow]); // mirroring twice is a no-op
console.log("mirror ok");
