// Checks that playbook files are validated before import: they come from other people.
import assert from "node:assert";
import { PACKAGE_TYPE, parsePackage } from "../src/share.ts";

const formats = ["9-man tackle"];
const valid = {
	type: PACKAGE_TYPE,
	version: 1,
	name: "Eagles",
	format: "9-man tackle",
	files: {
		"Playbook.md": "# Eagles",
		"Offense/Spread/Slant.md": "note",
		"Offense/Spread/Slant.excalidraw.md": "drawing",
		"../escape.md": "x",
		"Offense/../../escape.md": "x",
		".obsidian/plugins/x.md": "x",
		"/abs.md": "x",
		"C:\\\\win.md": "x",
		"script.js": "x",
		"Offense/Spread/Evil.excalidraw.md": "---\nexcalidraw-onload-script: alert(1)\n---",
		"Offense/Spread/NotText.md": 42,
	},
	formations: { "Offense/Trips.excalidraw.md": "f", "Special/Trips.excalidraw.md": "x", "Offense/a/b.excalidraw.md": "x" },
};
const { pkg, skipped } = parsePackage(JSON.stringify(valid), formats);
assert.deepEqual(Object.keys(pkg.files), ["Playbook.md", "Offense/Spread/Slant.md", "Offense/Spread/Slant.excalidraw.md"]);
assert.deepEqual(Object.keys(pkg.formations), ["Offense/Trips.excalidraw.md"]);
assert.equal(skipped, 10);

const fails = (data: unknown, message: RegExp) => assert.throws(() => parsePackage(JSON.stringify(data), formats), message);
assert.throws(() => parsePackage("not json", formats), /not a playbook file/);
fails({ ...valid, type: "something" }, /not a playbook file/);
fails({ ...valid, version: 2 }, /newer version/);
fails({ ...valid, format: "6-man" }, /Unknown playbook format/);
fails({ ...valid, name: " " }, /no name/);
fails({ ...valid, files: { "Offense/x.md": "x" } }, /missing its team notes/);
console.log("share ok");
