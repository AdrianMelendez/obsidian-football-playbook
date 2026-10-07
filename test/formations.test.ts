// Checks every built-in formation: right player count, inside the field, no overlapping players.
import assert from "node:assert";
import { FORMATS, YD, onHash, playerNames, readPlayers } from "../src/formations.ts";

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
// primary is the side at the bottom; undefined is how drawings made before 0.2 look (offense at the bottom).
type Side = "offense" | "defense";
const drawn = (side: Side, players: typeof FORMATS["9-man tackle"]["offense"][string], primary?: Side) =>
	players.flatMap(([label, x, depth]) => {
		const dir = primary === "defense" ? -1 : 1;
		const cx = x * YD * dir;
		const cy = (side === "offense" ? depth : -depth) * YD * dir;
		return [
			{ type: "ellipse", x: cx - 13, y: cy - 13, width: 26, height: 26, customData: { playbook: { side, label, primary } } },
			{ type: "text", x: cx - 6, y: cy - 8, width: 12, height: 16, text: label },
		];
	});
const offense = FORMATS["9-man tackle"].offense["2x2 Y Off"];
const defense = FORMATS["9-man tackle"].defense["2-4-3"];
for (const primary of [undefined, "offense", "defense"] as const) {
	const scene = [...drawn("offense", offense, primary), ...drawn("defense", defense, primary)];
	assert.deepEqual(readPlayers(scene, "offense"), offense, `offense read back, primary ${primary}`);
	assert.deepEqual(readPlayers(scene, "defense"), defense, `defense read back, primary ${primary}`);
}
// Defense first: the defense is drawn below the line of scrimmage (y > 0), turned around.
const fs = drawn("defense", defense, "defense").find((e) => e.text === "FS");
assert.ok(fs && fs.y > 0, "defense-first drawing puts the defense at the bottom");
const edited = drawn("offense", offense);
edited[1].text = "LT"; // renamed first player
edited[2] = { ...edited[2], isDeleted: true } as (typeof edited)[number]; // deleted second player
assert.deepEqual(readPlayers(edited, "offense").slice(0, 2).map((p) => p[0]), ["LT", "T"]);
// Ball on a hash: the core moves with the ball, nobody leaves the field or overlaps, and nobody swaps places.
for (const [format, f] of Object.entries(FORMATS)) {
	if (!f.hash) continue;
	for (const side of ["offense", "defense"] as const) {
		for (const [name, players] of Object.entries(f[side])) {
			assert.deepEqual(onHash(players, f, 0), players, `${format} ${name}: middle is unchanged`);
			for (const shift of [-f.hash, f.hash]) {
				const moved = onHash(players, f, shift);
				const where = `${format} ${side} "${name}" shifted ${shift.toFixed(1)}`;
				moved.forEach(([label, x], i) => {
					assert.ok(Math.abs(x) + 0.5 <= f.width / 2, `${where}: ${label} outside field`);
					if (Math.abs(players[i][1]) <= 4) assert.ok(Math.abs(x - (players[i][1] + shift)) < 0.06, `${where}: ${label} moves with the ball`);
				});
				for (let i = 0; i < players.length; i++) {
					for (let j = i + 1; j < players.length; j++) {
						const [a, ax, ad] = moved[i];
						const [b, bx, bd] = moved[j];
						assert.ok(Math.hypot(ax - bx, ad - bd) >= 0.9, `${where}: ${a} overlaps ${b}`);
						if (players[i][1] < players[j][1]) assert.ok(ax <= bx, `${where}: ${a} and ${b} swapped`);
					}
				}
			}
		}
	}
}
console.log("formations ok");
