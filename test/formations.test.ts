// Checks every built-in formation: right player count, inside the field, no overlapping players.
import assert from "node:assert";
import { FORMATS, YD, playerNames, readPlayers } from "../src/formations.ts";

for (const [format, f] of Object.entries(FORMATS)) {
	for (const side of ["offense", "defense"] as const) {
		for (const [name, players] of Object.entries(f[side])) {
			const where = `${format} ${side} "${name}"`;
			assert.equal(players.length, f.players, `${where}: player count`);
			for (const [label, x] of players) assert.ok(Math.abs(x) + 0.5 <= f.width / 2, `${where}: ${label} outside field`);
			const names = playerNames(side, players);
			assert.equal(new Set(names).size, names.length, `${where}: duplicate player names ${names}`);
			players.forEach(([a, ax, ad], i) =>
				players.slice(i + 1).forEach(([b, bx, bd]) =>
					assert.ok(Math.hypot(ax - bx, ad - bd) >= 0.9, `${where}: ${a} overlaps ${b}`)
				)
			);
		}
	}
}
assert.deepEqual(playerNames("defense", FORMATS["5v5 flag"].defense["Man (1-4)"]), ["R", "D right", "D left 1", "D left 2", "S"]);
// readPlayers gets back what was drawn: shape tagged with side/label, text centered in it (as drawPlayers does).
const drawn = (side: "offense" | "defense", players: typeof FORMATS["9-man tackle"]["offense"][string]) =>
	players.flatMap(([label, x, depth]) => {
		const cx = x * YD;
		const cy = (side === "offense" ? depth : -depth) * YD;
		return [
			{ type: "ellipse", x: cx - 13, y: cy - 13, width: 26, height: 26, customData: { playbook: { side, label } } },
			{ type: "text", x: cx - 6, y: cy - 8, width: 12, height: 16, text: label },
		];
	});
const offense = FORMATS["9-man tackle"].offense["2x2 Y Off"];
const defense = FORMATS["9-man tackle"].defense["2-4-3"];
assert.deepEqual(readPlayers([...drawn("offense", offense), ...drawn("defense", defense)], "offense"), offense);
assert.deepEqual(readPlayers([...drawn("offense", offense), ...drawn("defense", defense)], "defense"), defense);
const edited = drawn("offense", offense);
edited[1].text = "LT"; // renamed first player
edited[2] = { ...edited[2], isDeleted: true } as (typeof edited)[number]; // deleted second player
assert.deepEqual(readPlayers(edited, "offense").slice(0, 2).map((p) => p[0]), ["LT", "T"]);
console.log("formations ok");
