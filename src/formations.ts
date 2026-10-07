// Player positions in yards: [label, x from ball (+ = offense's right), depth off the line of scrimmage].
export type Player = [label: string, x: number, depth: number];
export type Side = "offense" | "defense";
export type Formation = Record<string, Player[]>;

export const YD = 30; // pixels per yard in drawings; the ball is at (0, 0)

interface Binding {
	focus?: number;
	fixedPoint?: [number, number] | null;
}

// Enough of an Excalidraw element to read players back from a drawing and to mirror it.
export interface DrawingElement {
	type: string;
	x: number;
	y: number;
	width: number;
	height: number;
	text?: string;
	isDeleted?: boolean;
	angle?: number;
	points?: [number, number][];
	startBinding?: Binding | null;
	endBinding?: Binding | null;
	// primary: the side drawn at the bottom. Missing in drawings made before it existed, which all had the offense there.
	customData?: { playbook?: { side: Side; label: string; primary?: Side } };
}

export interface Format {
	players: number;
	width: number; // field width in yards
	hash?: number; // hash mark x offset from the middle of the field (hashes split the field in thirds)
	offense: Formation;
	defense: Formation;
}

const OL: Player[] = [["LT", -2.6, 0.6], ["LG", -1.3, 0.6], ["C", 0, 0.6], ["RG", 1.3, 0.6], ["RT", 2.6, 0.6]];
const IL: Player[] = [["T", -1.3, 0.6], ["C", 0, 0.6], ["T", 1.3, 0.6]];

export const FORMATS: Record<string, Format> = {
	"11-man tackle": {
		players: 11,
		width: 53.3,
		hash: 53.3 / 6,
		offense: {
			"Shotgun Trips Right": [...OL, ["X", -20, 0.6], ["Y", 9, 1.5], ["H", 14, 1.5], ["Z", 20, 0.6], ["QB", 0, 5], ["RB", -1.5, 5]],
			"Spread 2x2": [...OL, ["X", -20, 0.6], ["H", -13, 1.5], ["Y", 13, 1.5], ["Z", 20, 0.6], ["QB", 0, 5], ["RB", 1.5, 5]],
			"Empty 3x2": [...OL, ["X", -20, 0.6], ["H", -13, 1.5], ["F", 8, 1.5], ["Y", 14, 1.5], ["Z", 20, 0.6], ["QB", 0, 5]],
			"I-Form Pro": [...OL, ["X", -18, 0.6], ["Y", 3.9, 0.6], ["Z", 15, 1.5], ["QB", 0, 1.6], ["FB", 0, 4.5], ["RB", 0, 7]],
			"Singleback Ace": [...OL, ["H", -3.9, 0.6], ["Y", 3.9, 0.6], ["X", -15, 1.5], ["Z", 15, 1.5], ["QB", 0, 1.6], ["RB", 0, 6]],
			"Pistol": [...OL, ["X", -20, 0.6], ["Y", 3.9, 0.6], ["H", -12, 1.5], ["Z", 15, 1.5], ["QB", 0, 4], ["RB", 0, 7]],
		},
		defense: {
			"4-3 Over": [["E", -3.5, 1], ["T", -1, 1], ["T", 1.5, 1], ["E", 4, 1], ["W", -4, 5], ["M", 0, 5], ["S", 4.5, 5], ["C", -19, 7], ["C", 19, 7], ["FS", -6, 12], ["SS", 6, 10]],
			"3-4": [["E", -3, 1], ["N", 0, 1], ["E", 3, 1], ["W", -5.5, 3], ["M", -1.5, 5], ["B", 1.5, 5], ["S", 5.5, 3], ["C", -19, 7], ["C", 19, 7], ["FS", -6, 12], ["SS", 6, 12]],
			"4-2-5 Nickel": [["E", -3.5, 1], ["T", -1, 1], ["T", 1.5, 1], ["E", 4, 1], ["M", -1.5, 5], ["W", 1.5, 5], ["NB", 10, 5], ["C", -19, 7], ["C", 19, 7], ["FS", -6, 12], ["SS", 6, 12]],
			"3-3-5 Stack": [["E", -3, 1], ["N", 0, 1], ["E", 3, 1], ["W", -3, 5], ["M", 0, 5], ["S", 3, 5], ["SS", -9, 8], ["NB", 9, 8], ["C", -19, 7], ["C", 19, 7], ["FS", 0, 12]],
		},
	},
	"9-man tackle": {
		players: 9,
		width: 40,
		hash: 40 / 6,
		offense: {
			"Spread": [...IL, ["E", -15, 0.6], ["E", 15, 0.6], ["H", -8, 1.5], ["Y", 8, 1.5], ["QB", 0, 5], ["RB", 1.5, 5]],
			"Trips Right": [...IL, ["E", -15, 0.6], ["Y", 5, 1.5], ["H", 10, 1.5], ["E", 15, 0.6], ["QB", 0, 5], ["RB", -1.5, 5]],
			"I-Form": [...IL, ["E", -2.6, 0.6], ["E", 2.6, 0.6], ["Z", 12, 1.5], ["QB", 0, 1.6], ["FB", 0, 4], ["RB", 0, 6.5]],
			"Double Wing": [...IL, ["E", -2.6, 0.6], ["E", 2.6, 0.6], ["W", -3.6, 1.5], ["W", 3.6, 1.5], ["QB", 0, 1.6], ["RB", 0, 5]],
			// Y attached to the tackle but off the ball; X and Z are the two ends on the line.
			"2x2 Y Off": [...IL, ["X", -12, 0.6], ["F", -6, 1.5], ["Y", 2.6, 1.5], ["Z", 12, 0.6], ["QB", 0, 5], ["RB", -1.5, 5]],
			"3x1 Y Off": [...IL, ["X", -12, 0.6], ["Y", 2.6, 1.5], ["F", 6, 1.5], ["Z", 12, 0.6], ["QB", 0, 5], ["RB", -1.5, 5]],
		},
		defense: {
			"3-3-3": [["E", -2.5, 1], ["N", 0, 1], ["E", 2.5, 1], ["W", -3, 5], ["M", 0, 5], ["S", 3, 5], ["C", -13, 7], ["C", 13, 7], ["FS", 0, 12]],
			"2-4-3": [["T", -1.5, 1], ["T", 1.5, 1], ["W", -5, 3], ["M", -1.5, 5], ["B", 1.5, 5], ["S", 5, 3], ["C", -13, 7], ["C", 13, 7], ["FS", 0, 12]],
			"4-2-3": [["E", -3, 1], ["T", -1, 1], ["T", 1, 1], ["E", 3, 1], ["W", -2, 5], ["M", 2, 5], ["C", -13, 7], ["C", 13, 7], ["FS", 0, 12]],
			"5-3-1 Goal Line": [["E", -3.5, 1], ["T", -1.5, 1], ["N", 0, 1], ["T", 1.5, 1], ["E", 3.5, 1], ["W", -3, 4], ["M", 0, 4], ["S", 3, 4], ["FS", 0, 8]],
		},
	},
	"5v5 flag": {
		players: 5,
		width: 30,
		offense: {
			"Spread 2x1": [["C", 0, 0.6], ["QB", 0, 5], ["X", -12, 0.6], ["Y", 6, 1.5], ["Z", 12, 0.6]],
			"Trips Right": [["C", 0, 0.6], ["QB", 0, 5], ["Z", 4, 1.5], ["Y", 8, 1.5], ["X", 12, 0.6]],
			"Stack": [["C", 0, 0.6], ["QB", 0, 5], ["X", -10, 0.6], ["Y", -10, 2.5], ["Z", 10, 0.6]],
			"Bunch Right": [["C", 0, 0.6], ["QB", 0, 5], ["X", 6, 0.6], ["Y", 7.5, 1.8], ["Z", 4.5, 2]],
		},
		defense: {
			"Man (1-4)": [["R", 0, 7], ["D", -12, 5], ["D", 6, 5], ["D", 12, 5], ["S", 0, 11]],
			"Zone 1-2-2": [["R", 0, 7], ["LB", -5, 5], ["LB", 5, 5], ["S", -7, 12], ["S", 7, 12]],
			"Zone 1-3-1": [["R", 0, 7], ["W", -9, 5], ["M", 3, 4], ["S", 9, 5], ["FS", 0, 13]],
		},
	},
};

// Unique player names for assignment notes: repeated labels get left/right (from that side's own view), then a number.
export function playerNames(side: Side, players: Player[]): string[] {
	const count = (list: string[], n: string) => list.filter((m) => m === n).length;
	const labels = players.map((p) => p[0]);
	const names = players.map(([label, x]) =>
		count(labels, label) > 1 ? `${label} ${(side === "offense" ? x < 0 : x > 0) ? "left" : "right"}` : label
	);
	return names.map((n, i) => (count(names, n) > 1 ? `${n} ${count(names.slice(0, i + 1), n)}` : n));
}

// Reads one side's players back from a drawing. The label is the text inside the player's shape, so editing that text
// in Excalidraw renames the player.
export function readPlayers(elements: DrawingElement[], side: Side): Player[] {
	const live = elements.filter((e) => !e.isDeleted);
	const texts = live.filter((e) => e.type === "text");
	const round = (v: number) => Math.round(v * 10) / 10 + 0; // + 0 turns -0 into 0
	return live.flatMap((e): Player[] => {
		const tag = e.customData?.playbook;
		if (tag?.side !== side) return [];
		const cx = e.x + e.width / 2;
		const cy = e.y + e.height / 2;
		const inside = (t: DrawingElement) =>
			Math.abs(t.x + t.width / 2 - cx) < e.width / 2 && Math.abs(t.y + t.height / 2 - cy) < e.height / 2;
		const label = texts.find(inside)?.text?.trim() || tag.label;
		// Back to offense-relative yards (y > 0 is the offense backfield); defense-first drawings are turned around.
		const dir = (tag.primary ?? "offense") === "offense" ? 1 : -1;
		const x = (cx / YD) * dir;
		const y = (cy / YD) * dir;
		return [[label, round(x), round(side === "offense" ? y : -y)]];
	});
}

const CORE = 4; // yards from the ball: the line, tight ends and backs, who move with the ball

// Moves a formation for the ball on a hash. shift: where the ball goes, in offense-relative yards. Players within CORE
// yards of the ball move with it; wider players keep their place between the core and their sideline, scaled to fit,
// so nobody ends up out of bounds.
export function onHash(players: Player[], format: Format, shift: number): Player[] {
	const half = format.width / 2;
	return players.map(([label, x, depth]): Player => {
		if (Math.abs(x) <= CORE) return [label, Math.round((x + shift) * 10) / 10 + 0, depth];
		const s = Math.sign(x);
		const t = (Math.abs(x) - CORE) / (half - CORE); // 0 at the edge of the core, 1 at the sideline
		const edge = shift + s * CORE;
		return [label, Math.round((edge + t * (s * half - edge)) * 10) / 10 + 0, depth];
	});
}
