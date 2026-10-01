// A shareable playbook: one JSON file with every note and drawing of a playbook, plus the formation library of its
// format. Files received from other people are untrusted, so parsing validates everything before anything is written.

export const PACKAGE_TYPE = "football-playbook";
export const PACKAGE_VERSION = 1;
// Stands for "<playbook folder>/" inside note text, so links keep working when the playbook is imported under another name.
export const FOLDER_TOKEN = "{{playbook}}/";

export interface PlaybookPackage {
	type: string;
	version: number;
	name: string;
	format: string;
	files: Record<string, string>; // path relative to the playbook folder -> content
	formations: Record<string, string>; // "Offense/<name>.excalidraw.md" or "Defense/..." -> content
}

const SEGMENT = /^[^\\/:*?"<>|#^[\]]+$/;
const FORMATION_PATH = /^(Offense|Defense)\/[^/]+\.excalidraw\.md$/;

// A relative path that stays inside its folder: no "..", no absolute or hidden parts, no characters invalid in file names.
export const safePath = (path: string) =>
	path.endsWith(".md") && path.split("/").every((part) => SEGMENT.test(part) && !part.startsWith(".") && part.trim() === part);

// Drops entries with unsafe paths, non-text content or an Excalidraw script that would run when the drawing opens.
function safeEntries(value: unknown, pathOk: (path: string) => boolean): [Record<string, string>, number] {
	const kept: Record<string, string> = {};
	let skipped = 0;
	if (typeof value !== "object" || value === null) return [kept, 0];
	for (const [path, content] of Object.entries(value)) {
		if (pathOk(path) && typeof content === "string" && !content.includes("excalidraw-onload-script")) kept[path] = content;
		else skipped++;
	}
	return [kept, skipped];
}

// Throws a readable error if the text is not a playbook file this version can import.
export function parsePackage(text: string, formats: string[]): { pkg: PlaybookPackage; skipped: number } {
	let data: Partial<PlaybookPackage>;
	try {
		data = JSON.parse(text) as Partial<PlaybookPackage>;
	} catch {
		throw new Error("This file is not a playbook file.");
	}
	if (data?.type !== PACKAGE_TYPE) throw new Error("This file is not a playbook file.");
	if (typeof data.version !== "number" || data.version > PACKAGE_VERSION) {
		throw new Error("This playbook was made with a newer version of Football Playbook. Update the plugin and try again.");
	}
	if (typeof data.name !== "string" || !data.name.trim()) throw new Error("The playbook file has no name.");
	if (typeof data.format !== "string" || !formats.includes(data.format)) {
		throw new Error(`Unknown playbook format "${String(data.format)}".`);
	}
	const [files, skippedFiles] = safeEntries(data.files, safePath);
	const [formations, skippedFormations] = safeEntries(data.formations, (p) => FORMATION_PATH.test(p) && safePath(p));
	if (!files["Playbook.md"]) throw new Error("The playbook file is missing its team notes (Playbook.md).");
	const pkg = { type: PACKAGE_TYPE, version: PACKAGE_VERSION, name: data.name, format: data.format, files, formations };
	return { pkg, skipped: skippedFiles + skippedFormations };
}
