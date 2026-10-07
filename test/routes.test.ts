// Checks route geometry and tag parsing.
import assert from "node:assert";
import { ROUTES, routePoints } from "../src/routes.ts";
import { parseTags, tagLabel } from "../src/tags.ts";

// Offense at the bottom (moves up the screen), player on the right side: an out breaks right, a slant breaks left.
assert.deepEqual(routePoints("Out", 100, 0, 1, -1, 30), [[100, 0], [100, -180], [250, -180]]);
assert.deepEqual(routePoints("Slant", 100, 0, 1, -1, 30), [[100, 0], [100, -90], [-50, -240]]);
// Player on the left side: the slant breaks right, toward the ball.
assert.deepEqual(routePoints("Slant", -100, 0, -1, -1, 30), [[-100, 0], [-100, -90], [50, -240]]);
// Defense-first drawing: the offense moves down the screen.
assert.deepEqual(routePoints("Go", 0, 0, 1, 1, 30), [[0, 0], [0, 450]]);
for (const [name, route] of Object.entries(ROUTES)) {
	assert.deepEqual(route.points[0], [0, 0], `${name} starts at the player`);
	assert.ok(route.points.every(([, down]) => down <= 15), `${name} stays inside the drawn field`);
}

assert.deepEqual(parseTags("Red zone, 3rd Down,  #pass, , 22, pass, play-action!"), ["red-zone", "3rd-down", "pass", "play-action"]);
assert.deepEqual(parseTags(""), []);
assert.equal(tagLabel("red-zone"), "red zone");
console.log("routes ok");
