// Standard routes in yards from the player: [toward the sideline the player is on, downfield]. Negative "toward the
// sideline" breaks inside, toward the ball. The same depths are used in every play, so plays look consistent.
export const ROUTES: Record<string, { points: [number, number][]; curved?: boolean }> = {
	Go: { points: [[0, 0], [0, 15]] },
	Slant: { points: [[0, 0], [0, 3], [-5, 8]] },
	Hitch: { points: [[0, 0], [0, 6], [-1, 4.5]] },
	Out: { points: [[0, 0], [0, 6], [5, 6]] },
	In: { points: [[0, 0], [0, 8], [-7, 8]] },
	Curl: { points: [[0, 0], [0, 10], [-1.5, 8.5]] },
	Comeback: { points: [[0, 0], [0, 12], [2, 10]] },
	Post: { points: [[0, 0], [0, 10], [-5, 15]] },
	Corner: { points: [[0, 0], [0, 10], [5, 15]] },
	Drag: { points: [[0, 0], [0, 2], [-12, 3]] },
	Flat: { points: [[0, 0], [1, 1], [5, 1.5]] },
	Wheel: { points: [[0, 0], [4, 1], [6, 3], [6.5, 12]], curved: true },
};

// Drawing coordinates of a route starting at (x, y). outside: 1 if the player's sideline is to the right on screen.
// forward: -1 if the player's team moves up the screen. yd: pixels per yard.
export function routePoints(
	route: string,
	x: number,
	y: number,
	outside: 1 | -1,
	forward: 1 | -1,
	yd: number
): [number, number][] {
	return ROUTES[route].points.map(([out, down]) => [x + out * outside * yd, y + down * forward * yd]);
}
