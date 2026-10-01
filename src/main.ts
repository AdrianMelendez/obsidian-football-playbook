import {
	App,
	ItemView,
	Menu,
	Modal,
	Notice,
	Platform,
	Plugin,
	Setting,
	TFile,
	TFolder,
	Vault,
	WorkspaceLeaf,
	debounce,
	normalizePath,
	setIcon,
} from "obsidian";
import { DrawingElement, FORMATS, Format, Player, Side, YD, playerNames, readPlayers } from "./formations";

const VIEW = "playbook-manager";
const ROOT = "Playbooks";
const LIBRARY = `${ROOT}/Formations`; // Formations/<format>/<Offense|Defense>/<name>.excalidraw.md
const DRAWING_EXT = ".excalidraw.md";
const EXCALIDRAW_URI = "obsidian://show-plugin?id=obsidian-excalidraw-plugin";
const R = 0.45 * YD; // player circle radius
const SIDES: Side[] = ["offense", "defense"];
const PLAY_CLASS = "football-play"; // styled in styles.css
const PAGE_BREAK = '<div style="page-break-after: always;"></div>';

// The subset of the Excalidraw plugin's ExcalidrawAutomate API used here.
interface ExcalidrawElement extends DrawingElement {
	locked: boolean;
}
interface ExcalidrawAutomate {
	style: Record<string, unknown>;
	reset(): void;
	addLine(points: [number, number][]): string;
	addRect(x: number, y: number, w: number, h: number): string;
	addEllipse(x: number, y: number, w: number, h: number): string;
	addText(x: number, y: number, text: string): string;
	addToGroup(ids: string[]): string;
	getElement(id: string): ExcalidrawElement;
	create(params: { filename: string; foldername: string; onNewPane: boolean; silent?: boolean }): Promise<string>;
	getSceneFromFile(file: TFile): Promise<{ elements: ExcalidrawElement[] } | null>;
	isExcalidrawFile(file: TFile): boolean;
	setView(view: "active"): unknown;
	getViewElements(): ExcalidrawElement[];
	getExcalidrawAPI(): { updateScene(scene: { appState: Record<string, unknown> }): void } | undefined;
	destroy?(): void;
}
declare global {
	interface Window {
		ExcalidrawAutomate?: { getAPI?(): ExcalidrawAutomate };
	}
}

interface Playbook {
	name: string;
	folder: TFolder;
	format: string;
	defense: boolean;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// Drops characters that are invalid in file names or break links, and leading dots (hidden files).
const clean = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/^\.+/, "").trim();
const other = (side: Side): Side => (side === "offense" ? "defense" : "offense");
const sidesOf = (pb: Playbook): Side[] => (pb.defense ? SIDES : ["offense"]);
const drawingName = (file: TFile) => file.name.slice(0, -DRAWING_EXT.length);
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true });
const showError = (e: unknown) => {
	console.error(e);
	new Notice(`Football Playbook: ${e instanceof Error ? e.message : String(e)}`);
};

export default class PlaybookPlugin extends Plugin {
	private seeding = Promise.resolve();

	onload() {
		this.registerView(VIEW, (leaf) => new ManagerView(leaf, this));
		this.addRibbonIcon("clipboard-list", "Open playbooks", () => void this.openManager());
		this.addCommand({ id: "open", name: "Open playbooks", callback: () => void this.openManager() });
		this.addCommand({ id: "new-playbook", name: "New playbook", callback: () => new PlaybookModal(this).open() });
		this.addCommand({ id: "new-play", name: "New play", callback: () => this.newPlay() });
		this.addCommand({ id: "save-formation", name: "Save current drawing as formation", callback: () => this.saveFormation() });
		this.addCommand({
			id: "restore-formations",
			name: "Restore built-in formations",
			callback: () => void Promise.all(this.formats().map((f) => this.ensureLibrary(f, true))).then(() => new Notice("Built-in formations restored.")),
		});
		this.app.workspace.onLayoutReady(() => this.formats().forEach((f) => void this.ensureLibrary(f)));
	}

	async openManager() {
		let leaf: WorkspaceLeaf | null = this.app.workspace.getLeavesOfType(VIEW)[0];
		if (!leaf) {
			leaf = this.app.workspace.getLeftLeaf(false);
			if (!leaf) return;
			await leaf.setViewState({ type: VIEW, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
	}

	ea(quiet = false): ExcalidrawAutomate | undefined {
		const ea = window.ExcalidrawAutomate?.getAPI?.();
		if (!ea && !quiet) {
			new Notice("Drawing plays needs the Excalidraw plugin. Install or enable it, then try again.");
			window.open(EXCALIDRAW_URI);
		}
		return ea;
	}

	playbooks(): Playbook[] {
		const root = this.app.vault.getAbstractFileByPath(ROOT);
		if (!(root instanceof TFolder)) return [];
		return root.children
			.flatMap((folder) => {
				if (!(folder instanceof TFolder)) return [];
				const file = this.app.vault.getAbstractFileByPath(`${folder.path}/Playbook.md`);
				const fm = file instanceof TFile ? this.app.metadataCache.getFileCache(file)?.frontmatter : undefined;
				const format = fm?.format as string | undefined;
				if (!format || !FORMATS[format]) return [];
				return [{ name: folder.name, folder, format, defense: fm?.defense === true }];
			})
			.sort(byName);
	}

	// Formats in use by at least one playbook.
	formats(): string[] {
		return [...new Set(this.playbooks().map((p) => p.format))];
	}

	libraryFolder(format: string, side: Side): string {
		return normalizePath(`${LIBRARY}/${format}/${cap(side)}`);
	}

	formationFiles(format: string, side: Side): TFile[] {
		const folder = this.app.vault.getAbstractFileByPath(this.libraryFolder(format, side));
		if (!(folder instanceof TFolder)) return [];
		return folder.children
			.filter((f): f is TFile => f instanceof TFile && f.name.endsWith(DRAWING_EXT))
			.sort((a, b) => byName({ name: drawingName(a) }, { name: drawingName(b) }));
	}

	formationFile(format: string, side: Side, name: string): TFile | undefined {
		return this.formationFiles(format, side).find((f) => drawingName(f) === name);
	}

	// Writes the built-in formations of a format into the library the first time it is used.
	// With restore, re-adds any built-in that is missing (deleted or renamed). Calls run one at a time.
	ensureLibrary(format: string, restore = false): Promise<void> {
		this.seeding = this.seeding.then(() => this.seedLibrary(format, restore)).catch(showError);
		return this.seeding;
	}

	private async seedLibrary(format: string, restore: boolean) {
		if (!restore && this.app.vault.getAbstractFileByPath(normalizePath(`${LIBRARY}/${format}`))) return;
		const ea = this.ea(!restore);
		if (!ea) return;
		try {
			for (const side of SIDES) {
				for (const [name, players] of Object.entries(FORMATS[format][side])) {
					if (this.formationFile(format, side, name)) continue;
					await this.writeDrawing(ea, format, this.libraryFolder(format, side), name, side, players);
				}
			}
		} finally {
			ea.destroy?.();
		}
	}

	async readFormation(ea: ExcalidrawAutomate, format: string, side: Side, name: string): Promise<Player[]> {
		const file = this.formationFile(format, side, name);
		const scene = file ? await ea.getSceneFromFile(file) : null;
		return scene ? readPlayers(scene.elements, side) : [];
	}

	// Draws the field and players and saves them as an Excalidraw file. Used for formations and plays.
	async writeDrawing(
		ea: ExcalidrawAutomate,
		format: string,
		folder: string,
		name: string,
		side: Side,
		players: Player[],
		opponent: Player[] = [],
		open = false
	) {
		await ensureFolder(this.app, folder);
		ea.reset();
		drawField(ea, FORMATS[format]);
		drawPlayers(ea, other(side), opponent, true);
		drawPlayers(ea, side, players, false);
		// ea.create saves the current style as the drawing's defaults for new strokes: thin, clean, black arrows.
		Object.assign(ea.style, {
			strokeColor: "#1e1e1e",
			backgroundColor: "transparent",
			strokeWidth: 1,
			strokeStyle: "solid",
			roughness: 0,
			opacity: 100,
			fontSize: 16,
			endArrowHead: "arrow",
		});
		await ea.create({ filename: name, foldername: folder, onNewPane: false, silent: !open });
		if (open) await this.straightArrows(ea, normalizePath(`${folder}/${name}${DRAWING_EXT}`));
	}

	// Excalidraw draws multi-point arrows curved by default; routes read better as straight segments. ea.create can't set
	// this, so set it once the drawing is open. Excalidraw saves it with the drawing on the next change.
	private async straightArrows(ea: ExcalidrawAutomate, path: string) {
		for (let i = 0; i < 30; i++) {
			await sleep(100);
			if (this.app.workspace.getActiveFile()?.path !== path || !ea.setView("active")) continue;
			const api = ea.getExcalidrawAPI();
			if (api) return api.updateScene({ appState: { currentItemArrowType: "sharp" } });
		}
	}

	// Renames or copies a library formation. A rename also renames the play folders named after it in every playbook of
	// that format, and updates those plays' embeds, subtitle and formation property.
	async moveFormation(file: TFile, format: string, side: Side, name: string, copy: boolean) {
		const newPath = normalizePath(`${this.libraryFolder(format, side)}/${name}${DRAWING_EXT}`);
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`Formation "${name}" already exists.`);
			return;
		}
		if (copy) {
			await this.app.vault.copy(file, newPath);
			return;
		}
		const oldName = drawingName(file);
		await this.app.fileManager.renameFile(file, newPath);
		for (const pb of this.playbooks().filter((p) => p.format === format)) {
			const folder = this.app.vault.getAbstractFileByPath(`${pb.folder.path}/${cap(side)}/${oldName}`);
			const newFolder = normalizePath(`${pb.folder.path}/${cap(side)}/${name}`);
			if (!(folder instanceof TFolder) || this.app.vault.getAbstractFileByPath(newFolder)) continue;
			const oldFolder = folder.path;
			await this.app.fileManager.renameFile(folder, newFolder);
			for (const play of folder.children) {
				if (!(play instanceof TFile) || play.extension !== "md" || play.name.endsWith(DRAWING_EXT)) continue;
				await this.app.vault.process(play, (text) =>
					text.split(`${oldFolder}/`).join(`${newFolder}/`).split(`· ${oldName}*`).join(`· ${name}*`)
				);
				await this.app.fileManager.processFrontMatter(play, (fm: Record<string, unknown>) => {
					fm.formation = name;
				});
			}
		}
	}

	// Formation folders of one side that contain plays, with their play notes (drawings excluded).
	plays(pb: Playbook, side: Side): [TFolder, TFile[]][] {
		const sideFolder = pb.folder.children.find((f) => f instanceof TFolder && f.name === cap(side));
		if (!(sideFolder instanceof TFolder)) return [];
		return sideFolder.children
			.filter((f): f is TFolder => f instanceof TFolder)
			.sort(byName)
			.map((formation): [TFolder, TFile[]] => [
				formation,
				formation.children
					.filter((f): f is TFile => f instanceof TFile && f.extension === "md" && !f.name.endsWith(DRAWING_EXT))
					.sort((a, b) => byName({ name: a.basename }, { name: b.basename })),
			])
			.filter(([, plays]) => plays.length > 0);
	}

	drawingOf(note: TFile): TFile | null {
		const file = this.app.vault.getAbstractFileByPath(normalizePath(`${note.parent?.path ?? ""}/${note.basename}.excalidraw.md`));
		return file instanceof TFile ? file : null;
	}

	async newPlay(pb?: Playbook) {
		if (!this.playbooks().length) {
			new Notice("Create a playbook first.");
			new PlaybookModal(this).open();
			return;
		}
		await Promise.all(this.formats().map((f) => this.ensureLibrary(f)));
		new PlayModal(this, pb).open();
	}

	async createPlaybook(name: string, format: string, defense: boolean) {
		const folder = normalizePath(`${ROOT}/${name}`);
		if (this.app.vault.getAbstractFileByPath(folder)) {
			new Notice(`Playbook "${name}" already exists.`);
			return;
		}
		await ensureFolder(this.app, folder);
		await this.app.vault.create(
			`${folder}/Playbook.md`,
			`---\nformat: ${JSON.stringify(format)}\ndefense: ${defense}\n---\n# ${name}\n\nTeam notes go here.\n`
		);
		await this.openManager();
		await this.ensureLibrary(format);
	}

	async createPlay(pb: Playbook, side: Side, formation: string, name: string, opponent: string) {
		const folder = normalizePath(`${pb.folder.path}/${cap(side)}/${formation}`);
		const note = `${folder}/${name}.md`;
		const drawing = `${folder}/${name}${DRAWING_EXT}`;
		if (this.app.vault.getAbstractFileByPath(note) || this.app.vault.getAbstractFileByPath(drawing)) {
			new Notice(`Play "${name}" already exists in ${formation}.`);
			return;
		}
		const ea = this.ea();
		if (!ea) return;
		try {
			const players = await this.readFormation(ea, pb.format, side, formation);
			if (!players.length) {
				new Notice(`Formation "${formation}" has no ${side} players.`);
				return;
			}
			const opponentPlayers = opponent ? await this.readFormation(ea, pb.format, other(side), opponent) : [];
			await ensureFolder(this.app, folder);
			await this.app.vault.create(
				note,
				[
					"---",
					`playbook: ${JSON.stringify(pb.name)}`,
					`side: ${side}`,
					`formation: ${JSON.stringify(formation)}`,
					...(opponent ? [`opponent: ${JSON.stringify(opponent)}`] : []),
					"tags: [play]",
					`cssclasses: [${PLAY_CLASS}]`,
					"---",
					`# ${name}`,
					`*${cap(side)} · ${formation}*`,
					"",
					`![[${drawing}|700]]`,
					"",
					"| Player | Assignment |",
					"| --- | --- |",
					...playerNames(side, players).map((player) => `| ${player} |  |`),
					"",
					"> [!key] Key to the play",
					"> ",
					"",
					"## Notes",
					"",
				].join("\n")
			);
			await this.writeDrawing(ea, pb.format, folder, name, side, players, opponentPlayers, true);
		} finally {
			ea.destroy?.();
		}
	}

	// Renames or copies a play's note and drawing, then points the note's embed at the new drawing.
	async movePlay(note: TFile, name: string, copy: boolean) {
		const folder = note.parent?.path ?? "";
		const newNote = normalizePath(`${folder}/${name}.md`);
		const newDrawing = normalizePath(`${folder}/${name}.excalidraw.md`);
		if (this.app.vault.getAbstractFileByPath(newNote) || this.app.vault.getAbstractFileByPath(newDrawing)) {
			new Notice(`Play "${name}" already exists here.`);
			return;
		}
		const drawing = this.drawingOf(note);
		const oldDrawing = drawing?.path;
		const oldName = note.basename; // read before renameFile mutates note
		let target = note;
		if (copy) {
			target = await this.app.vault.copy(note, newNote);
			if (drawing) await this.app.vault.copy(drawing, newDrawing);
		} else {
			if (drawing) await this.app.fileManager.renameFile(drawing, newDrawing);
			await this.app.fileManager.renameFile(note, newNote);
		}
		await this.app.vault.process(target, (text) => {
			if (oldDrawing) text = text.split(oldDrawing).join(newDrawing);
			return text.split(`\n# ${oldName}\n`).join(`\n# ${name}\n`);
		});
	}

	// Renames the playbook folder and updates the links and properties that contain its path or name.
	async renamePlaybook(pb: Playbook, name: string) {
		const newPath = normalizePath(`${ROOT}/${name}`);
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`"${name}" already exists.`);
			return;
		}
		const oldPath = pb.folder.path;
		await this.app.fileManager.renameFile(pb.folder, newPath);
		const notes: TFile[] = [];
		Vault.recurseChildren(pb.folder, (f) => {
			if (f instanceof TFile && f.extension === "md" && !f.name.endsWith(DRAWING_EXT)) notes.push(f);
		});
		for (const note of notes) {
			const isTeamNotes = note.name === "Playbook.md";
			await this.app.vault.process(note, (text) => {
				text = text.split(`${oldPath}/`).join(`${newPath}/`);
				return isTeamNotes ? text.split(`\n# ${pb.name}\n`).join(`\n# ${name}\n`) : text;
			});
			if (!isTeamNotes) {
				await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
					if ("playbook" in fm) fm.playbook = name;
				});
			}
		}
	}

	async deletePlay(note: TFile) {
		const folder = note.parent;
		const drawing = this.drawingOf(note);
		if (drawing) await this.app.fileManager.trashFile(drawing);
		await this.app.fileManager.trashFile(note);
		if (folder && folder.children.length === 0) await this.app.fileManager.trashFile(folder);
	}

	// Writes <playbook>/Export.md embedding the team notes and every play, one per page, then opens Obsidian's PDF export.
	async exportPdf(pb: Playbook) {
		if (Platform.isMobile) {
			new Notice("PDF export is only available on desktop.");
			return;
		}
		const parts = [`![[${pb.folder.path}/Playbook.md]]`];
		for (const side of sidesOf(pb)) {
			for (const [, plays] of this.plays(pb, side)) {
				for (const play of plays) {
					parts.push(PAGE_BREAK, `![[${play.path}]]`);
				}
			}
		}
		if (parts.length === 1) {
			new Notice("This playbook has no plays yet.");
			return;
		}
		const path = normalizePath(`${pb.folder.path}/Export.md`);
		const content = [
			`---\ncssclasses: [${PLAY_CLASS}]\n---`,
			"%% Generated by Football Playbook. Changes here are overwritten on the next export. %%",
			...parts,
		].join("\n\n");
		const existing = this.app.vault.getAbstractFileByPath(path);
		let file: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			file = existing;
		} else {
			file = await this.app.vault.create(path, content);
		}
		await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
		// Not public API; fall back to telling the user where the menu item is.
		const commands = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
		if (!commands?.executeCommandById("workspace:export-pdf")) {
			new Notice("Open this note's menu and choose the PDF export option.");
		}
	}

	saveFormation() {
		const file = this.app.workspace.getActiveFile();
		const pb = file && this.playbooks().find((p) => file.path.startsWith(p.folder.path + "/"));
		const ea = pb ? this.ea() : undefined;
		if (!file || !pb || !ea || !ea.isExcalidrawFile(file) || !ea.setView("active")) {
			new Notice("Open a play drawing first.");
			return;
		}
		// Plays live in <playbook>/<Offense|Defense>/<formation>/, so the folder tells the side.
		const side = file.path.slice(pb.folder.path.length + 1).split("/")[0].toLowerCase() as Side;
		const players = readPlayers(ea.getViewElements(), side);
		ea.destroy?.();
		if (!players.length) {
			new Notice(`No ${side} players found in this drawing.`);
			return;
		}
		new NameModal(this.app, `Save ${side} formation`, "", async (name) => {
			if (this.formationFile(pb.format, side, name)) {
				new Notice(`Formation "${name}" already exists.`);
				return;
			}
			const writer = this.ea();
			if (!writer) return;
			try {
				await this.writeDrawing(writer, pb.format, this.libraryFolder(pb.format, side), name, side, players);
				new Notice(`Saved formation "${name}" for ${pb.format} ${side}.`);
			} finally {
				writer.destroy?.();
			}
		}).open();
	}
}

async function ensureFolder(app: App, path: string) {
	let cur = "";
	for (const part of path.split("/")) {
		cur = cur ? `${cur}/${part}` : part;
		if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur);
	}
}

// Field window: 20 yards downfield (up) to 10 yards behind the line of scrimmage (down). y = 0 is the LOS.
function drawField(ea: ExcalidrawAutomate, f: Format) {
	const half = (f.width / 2) * YD;
	const ids: string[] = [];
	const line = (x1: number, y1: number, x2: number, y2: number) => ids.push(ea.addLine([[x1, y1], [x2, y2]]));

	// Grey background, drawn first so it sits under everything. Covers the yard numbers outside the sidelines.
	const pad = 2.5 * YD;
	Object.assign(ea.style, {
		strokeColor: "transparent",
		backgroundColor: "#f1f3f5",
		fillStyle: "solid",
		strokeWidth: 1,
		strokeStyle: "solid",
		roughness: 0,
		opacity: 100,
		roundness: { type: 3 },
	});
	ids.push(ea.addRect(-half - pad, -21 * YD, 2 * (half + pad), 32 * YD));
	Object.assign(ea.style, { strokeColor: "#adb5bd", roundness: null });

	line(-half, -20 * YD, -half, 10 * YD);
	line(half, -20 * YD, half, 10 * YD);
	for (let y = -20; y <= 10; y += 5) if (y) line(-half, y * YD, half, y * YD);
	if (f.hash) {
		for (let y = -20; y <= 10; y++) {
			for (const x of [-f.hash, f.hash]) line((x - 0.4) * YD, y * YD, (x + 0.4) * YD, y * YD);
		}
	}

	// Yards from the line of scrimmage, written just outside both sidelines.
	Object.assign(ea.style, { strokeColor: "#adb5bd", fontFamily: 2, fontSize: 18 });
	for (let y = -20; y <= 10; y += 5) {
		if (!y) continue;
		for (const left of [true, false]) {
			const id = ea.addText(0, 0, String(Math.abs(y)));
			const t = ea.getElement(id);
			t.x = left ? -half - 0.5 * YD - t.width : half + 0.5 * YD;
			t.y = y * YD - t.height / 2;
			ids.push(id);
		}
	}

	Object.assign(ea.style, { strokeColor: "#1971c2", strokeWidth: 2, strokeStyle: "dashed" });
	line(-half, 0, half, 0);

	for (const id of ids) ea.getElement(id).locked = true;
	ea.addToGroup(ids);
}

function drawPlayers(ea: ExcalidrawAutomate, side: Side, players: Player[], ghost: boolean) {
	Object.assign(ea.style, {
		strokeColor: side === "offense" ? "#1e1e1e" : "#e03131",
		backgroundColor: "#ffffff",
		fillStyle: "solid",
		strokeWidth: 2,
		strokeStyle: "solid",
		roughness: 0,
		opacity: ghost ? 35 : 100,
		fontFamily: 2,
		fontSize: 14,
	});
	for (const [label, x, depth] of players) {
		const cx = x * YD;
		const cy = (side === "offense" ? depth : -depth) * YD;
		const shape = label === "C" && side === "offense" ? ea.addRect(cx - R, cy - R, 2 * R, 2 * R) : ea.addEllipse(cx - R, cy - R, 2 * R, 2 * R);
		ea.getElement(shape).customData = { playbook: { side, label } };
		const text = ea.addText(0, 0, label);
		const t = ea.getElement(text);
		t.x = cx - t.width / 2;
		t.y = cy - t.height / 2;
		ea.addToGroup([shape, text]);
	}
}

class ManagerView extends ItemView {
	sections = new Map<string, boolean>(); // open/closed per section, kept across re-renders
	activePath = "";

	constructor(leaf: WorkspaceLeaf, private plugin: PlaybookPlugin) {
		super(leaf);
	}
	getViewType() {
		return VIEW;
	}
	getDisplayText() {
		return "Playbooks";
	}
	getIcon() {
		return "clipboard-list";
	}

	async onOpen() {
		const refresh = debounce(() => this.render(), 300, true);
		this.registerEvent(this.app.vault.on("create", refresh));
		this.registerEvent(this.app.vault.on("delete", refresh));
		this.registerEvent(this.app.vault.on("rename", refresh));
		this.registerEvent(this.app.metadataCache.on("changed", refresh));
		this.registerEvent(this.app.workspace.on("file-open", refresh));
		this.app.workspace.onLayoutReady(() => this.render());
	}

	openOrWarn(file: TFile | null) {
		if (file) void this.app.workspace.getLeaf(false).openFile(file);
		else new Notice("File not found.");
	}

	render() {
		const el = this.contentEl;
		el.empty();
		el.addClass("playbook-manager");
		this.activePath = this.app.workspace.getActiveFile()?.path ?? "";

		if (!window.ExcalidrawAutomate) {
			const warn = el.createDiv({ cls: "pb-warn", text: "Drawing plays needs the Excalidraw plugin." });
			warn.createEl("button", { text: "Install Excalidraw" }).onclick = () => window.open(EXCALIDRAW_URI);
		}

		const top = el.createDiv({ cls: "pb-top" });
		const newPlay = top.createEl("button", { cls: "mod-cta pb-new-play" });
		setIcon(newPlay.createSpan({ cls: "pb-btn-icon" }), "plus");
		newPlay.createSpan({ text: "New play" });
		newPlay.onclick = () => void this.plugin.newPlay().catch(showError);
		const newBook = top.createEl("button", { cls: "pb-new-book", attr: { "aria-label": "New playbook" } });
		setIcon(newBook, "folder-plus");
		newBook.onclick = () => new PlaybookModal(this.plugin).open();

		const playbooks = this.plugin.playbooks();
		if (!playbooks.length) {
			const empty = el.createDiv({ cls: "pb-empty" });
			setIcon(empty.createDiv({ cls: "pb-empty-icon" }), "clipboard-list");
			empty.createDiv({ text: "No playbooks yet." });
			empty.createEl("button", { text: "Create a playbook" }).onclick = () => new PlaybookModal(this.plugin).open();
			return;
		}

		for (const pb of playbooks) {
			const { summary, body } = this.section(el, `pb:${pb.name}`, pb.name, pb.format, playbooks.length === 1);
			const actions = summary.createSpan({ cls: "pb-actions" });
			this.iconButton(actions, "plus", "New play", () => void this.plugin.newPlay(pb).catch(showError));
			this.iconButton(actions, "file-text", "Team notes", () => {
				const notes = this.app.vault.getAbstractFileByPath(`${pb.folder.path}/Playbook.md`);
				this.openOrWarn(notes instanceof TFile ? notes : null);
			});
			this.iconButton(actions, "printer", "Export PDF", () => void this.plugin.exportPdf(pb).catch(showError));
			const menu = () =>
				this.itemMenu("playbook", pb.name, "All its plays, notes and drawings are moved to the trash.", {
					rename: (name) => this.plugin.renamePlaybook(pb, name),
					remove: () => this.app.fileManager.trashFile(pb.folder),
				});
			this.iconButton(actions, "more-horizontal", "More", (button) => {
				const rect = button.getBoundingClientRect();
				menu().showAtPosition({ x: rect.left, y: rect.bottom });
			});
			summary.oncontextmenu = (evt) => {
				evt.preventDefault();
				menu().showAtMouseEvent(evt);
			};

			for (const side of sidesOf(pb)) {
				const formations = this.plugin.plays(pb, side);
				const count = formations.reduce((n, [, plays]) => n + plays.length, 0);
				this.label(body, cap(side), count ? String(count) : "");
				if (!formations.length) body.createDiv({ cls: "pb-hint", text: "No plays yet" });

				for (const [formation, plays] of formations) {
					body.createDiv({ cls: "pb-group", text: formation.name });
					const children = body.createDiv({ cls: "pb-children" });
					for (const play of plays) {
						const drawing = this.plugin.drawingOf(play);
						this.row(
							children,
							"route",
							play.basename,
							drawing ?? play, // the drawing; the note if the drawing is missing
							[play.path, drawing?.path ?? ""],
							() =>
								this.itemMenu("play", play.basename, "The play note and its drawing are moved to the trash.", {
									rename: (name) => this.plugin.movePlay(play, name, false),
									duplicate: (name) => this.plugin.movePlay(play, name, true),
									remove: () => this.plugin.deletePlay(play),
								}),
							(rowActions) => this.iconButton(rowActions, "file-text", "Open notes", () => this.openOrWarn(play))
						);
					}
				}
			}
		}

		// Formation library, for the formats in use. Each formation is a drawing: open it to see or move players.
		const formats = this.plugin.formats();
		const lib = this.section(el, LIBRARY, "Formations", "", false);
		lib.details.addClass("pb-library");
		lib.body.createDiv({ cls: "pb-hint", text: "Open a formation to move or rename its players. New plays use its current drawing." });
		for (const format of formats) {
			this.label(lib.body, format, "");
			const sides: Side[] = playbooks.some((p) => p.format === format && p.defense) ? SIDES : ["offense"];
			for (const side of sides) {
				lib.body.createDiv({ cls: "pb-group", text: cap(side) });
				const children = lib.body.createDiv({ cls: "pb-children" });
				for (const file of this.plugin.formationFiles(format, side)) {
					this.row(children, "users", drawingName(file), file, [file.path], () =>
						this.itemMenu("formation", drawingName(file), "Plays already made from it are not affected.", {
							rename: (name) => this.plugin.moveFormation(file, format, side, name, false),
							duplicate: (name) => this.plugin.moveFormation(file, format, side, name, true),
							remove: () => this.app.fileManager.trashFile(file),
						})
					);
				}
			}
		}
	}

	// Collapsible block with a chevron, title and optional badge.
	section(parent: HTMLElement, key: string, title: string, badge: string, defaultOpen: boolean) {
		const details = parent.createEl("details", { cls: "pb-section" });
		details.open = this.sections.get(key) ?? defaultOpen;
		details.ontoggle = () => this.sections.set(key, details.open);
		const summary = details.createEl("summary", { cls: "pb-summary" });
		setIcon(summary.createSpan({ cls: "pb-chevron" }), "chevron-right");
		summary.createSpan({ cls: "pb-title", text: title });
		if (badge) summary.createSpan({ cls: "pb-badge", text: badge });
		return { details, summary, body: details.createDiv({ cls: "pb-body" }) };
	}

	label(parent: HTMLElement, text: string, count: string) {
		const label = parent.createDiv({ cls: "pb-label" });
		label.createSpan({ text });
		if (count) label.createSpan({ cls: "pb-count", text: count });
	}

	iconButton(parent: HTMLElement, icon: string, label: string, onClick: (button: HTMLElement) => void): HTMLElement {
		const button = parent.createDiv({ cls: "clickable-icon pb-icon", attr: { "aria-label": label, role: "button", tabindex: "0" } });
		setIcon(button, icon);
		button.onclick = (evt) => {
			evt.preventDefault(); // inside <summary> a click would also toggle the section
			evt.stopPropagation();
			onClick(button);
		};
		button.onkeydown = (evt) => {
			if (evt.key === "Enter" || evt.key === " ") {
				evt.preventDefault();
				button.click();
			}
		};
		return button;
	}

	// A clickable list row that opens a file, with hover actions, a "More" menu and right-click.
	row(
		parent: HTMLElement,
		icon: string,
		text: string,
		file: TFile | null,
		activePaths: string[],
		menu: () => Menu,
		addActions?: (actions: HTMLElement) => void
	) {
		const row = parent.createDiv({ cls: "pb-row", attr: { role: "button", tabindex: "0" } });
		row.toggleClass("is-active", activePaths.includes(this.activePath));
		setIcon(row.createSpan({ cls: "pb-row-icon" }), icon);
		row.createSpan({ cls: "pb-row-title", text });
		const actions = row.createSpan({ cls: "pb-actions" });
		addActions?.(actions);
		this.iconButton(actions, "more-horizontal", "More", (button) => {
			const rect = button.getBoundingClientRect();
			menu().showAtPosition({ x: rect.left, y: rect.bottom });
		});
		row.onclick = () => this.openOrWarn(file);
		row.onkeydown = (evt) => {
			if (evt.key === "Enter" && evt.target === row) this.openOrWarn(file);
		};
		row.oncontextmenu = (evt) => {
			evt.preventDefault();
			menu().showAtMouseEvent(evt);
		};
	}

	itemMenu(
		kind: string,
		current: string,
		deleteNote: string,
		actions: { rename: (name: string) => Promise<void>; duplicate?: (name: string) => Promise<void>; remove: () => Promise<void> }
	): Menu {
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Rename")
				.setIcon("pencil-line")
				.onClick(() => new NameModal(this.app, `Rename ${kind}`, current, (name) => actions.rename(name).catch(showError)).open())
		);
		const duplicate = actions.duplicate;
		if (duplicate) {
			menu.addItem((item) =>
				item
					.setTitle("Duplicate")
					.setIcon("copy")
					.onClick(() =>
						new NameModal(this.app, `Duplicate ${kind}`, `${current} copy`, (name) => duplicate(name).catch(showError)).open()
					)
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash")
				.setWarning(true)
				.onClick(() => new ConfirmModal(this.app, `Delete "${current}"?`, deleteNote, () => actions.remove().catch(showError)).open())
		);
		return menu;
	}
}

// Base for the small forms: Enter submits.
abstract class FormModal extends Modal {
	abstract submit(): void;

	onOpen() {
		this.scope.register([], "Enter", (evt) => {
			evt.preventDefault();
			this.submit();
		});
	}
}

class PlaybookModal extends FormModal {
	name = "";
	format = Object.keys(FORMATS)[0];
	defense = true;

	constructor(private plugin: PlaybookPlugin) {
		super(plugin.app);
	}

	onOpen() {
		super.onOpen();
		this.titleEl.setText("New playbook");
		new Setting(this.contentEl).setName("Team / playbook name").addText((t) => t.onChange((v) => (this.name = v)));
		new Setting(this.contentEl).setName("Format").addDropdown((d) => {
			for (const f of Object.keys(FORMATS)) d.addOption(f, f);
			d.setValue(this.format).onChange((v) => (this.format = v));
		});
		new Setting(this.contentEl)
			.setName("Include defense")
			.addToggle((t) => t.setValue(this.defense).onChange((v) => (this.defense = v)));
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(() => this.submit()));
	}

	submit() {
		if (!clean(this.name)) return void new Notice("Enter a name.");
		this.close();
		void this.plugin.createPlaybook(clean(this.name), this.format, this.defense).catch(showError);
	}
}

class PlayModal extends FormModal {
	pb: Playbook;
	side: Side = "offense";
	formation = "";
	opponent = "";
	name = "";

	constructor(private plugin: PlaybookPlugin, pb?: Playbook) {
		super(plugin.app);
		this.pb = pb ?? plugin.playbooks()[0];
	}

	onOpen() {
		super.onOpen();
		this.titleEl.setText("New play");
		this.render();
	}

	// Re-rendered when playbook or side changes, because the formation lists depend on them.
	render() {
		const el = this.contentEl;
		el.empty();
		const formations = this.plugin.formationFiles(this.pb.format, this.side).map(drawingName);
		if (!formations.includes(this.formation)) this.formation = formations[0];

		new Setting(el).setName("Playbook").addDropdown((d) => {
			for (const p of this.plugin.playbooks()) d.addOption(p.name, `${p.name} (${p.format})`);
			d.setValue(this.pb.name).onChange((v) => {
				this.pb = this.plugin.playbooks().find((p) => p.name === v) ?? this.pb;
				if (!this.pb.defense) this.side = "offense";
				this.opponent = "";
				this.render();
			});
		});
		if (this.pb.defense) {
			new Setting(el).setName("Side").addDropdown((d) => {
				for (const s of SIDES) d.addOption(s, cap(s));
				d.setValue(this.side).onChange((v) => {
					this.side = v as Side;
					this.opponent = "";
					this.render();
				});
			});
		}
		new Setting(el).setName("Formation").addDropdown((d) => {
			for (const f of formations) d.addOption(f, f);
			d.setValue(this.formation).onChange((v) => (this.formation = v));
		});
		if (this.pb.defense) {
			new Setting(el)
				.setName(`Against ${other(this.side)} formation`)
				.setDesc("Optional. Drawn faded so you can see the matchup.")
				.addDropdown((d) => {
					d.addOption("", "None");
					for (const f of this.plugin.formationFiles(this.pb.format, other(this.side)).map(drawingName)) d.addOption(f, f);
					d.setValue(this.opponent).onChange((v) => (this.opponent = v));
				});
		}
		new Setting(el).setName("Play name").addText((t) => t.setValue(this.name).onChange((v) => (this.name = v)));
		new Setting(el).addButton((b) => b.setButtonText("Create play").setCta().onClick(() => this.submit()));
	}

	submit() {
		if (!this.formation) return void new Notice("No formations found. Use the command to restore built-in formations.");
		if (!clean(this.name)) return void new Notice("Enter a play name.");
		this.close();
		void this.plugin.createPlay(this.pb, this.side, this.formation, clean(this.name), this.opponent).catch(showError);
	}
}

class NameModal extends FormModal {
	constructor(app: App, private title: string, private name: string, private onSubmit: (name: string) => Promise<void>) {
		super(app);
	}

	onOpen() {
		super.onOpen();
		this.titleEl.setText(this.title);
		new Setting(this.contentEl).setName("Name").addText((t) => t.setValue(this.name).onChange((v) => (this.name = v)));
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Save").setCta().onClick(() => this.submit()));
	}

	submit() {
		if (!clean(this.name)) return void new Notice("Enter a name.");
		this.close();
		void this.onSubmit(clean(this.name)).catch(showError);
	}
}

class ConfirmModal extends FormModal {
	constructor(app: App, private title: string, private message: string, private onConfirm: () => Promise<void>) {
		super(app);
	}

	onOpen() {
		super.onOpen();
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.message });
		new Setting(this.contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			// mod-warning class instead of setWarning() (deprecated) or setDestructive() (needs Obsidian 1.13).
			.addButton((b) => {
				b.setButtonText("Delete").onClick(() => this.submit());
				b.buttonEl.addClass("mod-warning");
			});
	}

	submit() {
		this.close();
		void this.onConfirm().catch(showError);
	}
}
