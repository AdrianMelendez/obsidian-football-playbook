import {
	App,
	FuzzySuggestModal,
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
import { mirrorElements, mirrorNote, mirroredName } from "./mirror";
import { FOLDER_TOKEN, PACKAGE_TYPE, PACKAGE_VERSION, PlaybookPackage, parsePackage } from "./share";

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
	id: string;
	locked: boolean;
}
interface ExcalidrawAutomate {
	style: Record<string, unknown>;
	elementsDict: Record<string, ExcalidrawElement>;
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
	offense: boolean;
	defense: boolean;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
// Drops characters that are invalid in file names or break links, and leading dots (hidden files).
const clean = (s: string) => s.replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/^\.+/, "").trim();
const other = (side: Side): Side => (side === "offense" ? "defense" : "offense");
const sidesOf = (pb: Playbook): Side[] => SIDES.filter((side) => pb[side]);
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
		this.addCommand({ id: "import-playbook", name: "Import playbook", callback: () => this.pickImportFile() });
		this.addCommand({
			id: "share-playbook",
			name: "Share playbook",
			callback: () => this.choosePlaybook((pb) => void this.sharePlaybook(pb).catch(showError)),
		});
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
				const defense = fm?.defense === true;
				return [{ name: folder.name, folder, format, offense: fm?.offense !== false || !defense, defense }];
			})
			.sort(byName);
	}

	choosePlaybook(choose: (pb: Playbook) => void) {
		const playbooks = this.playbooks();
		if (playbooks.length === 1) choose(playbooks[0]);
		else if (playbooks.length) new PlaybookSuggest(this, choose).open();
		else new Notice("No playbooks yet.");
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

	// Draws the field and players and saves them as an Excalidraw file. Used for formations and plays. The drawing's own
	// side is at the bottom and highlighted; the opponent, if any, is faded at the top.
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
		drawField(ea, FORMATS[format], side);
		drawPlayers(ea, other(side), opponent, true, side);
		drawPlayers(ea, side, players, false, side);
		await this.saveDrawing(ea, folder, name, open);
	}

	// Saves the elements in ea as <folder>/<name>.excalidraw.md, optionally opening it.
	private async saveDrawing(ea: ExcalidrawAutomate, folder: string, name: string, open: boolean) {
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

	// Writes a left-right mirrored copy of a drawing as <folder>/<name>.excalidraw.md and opens it.
	private async writeMirror(ea: ExcalidrawAutomate, file: TFile, folder: string, name: string) {
		const scene = await ea.getSceneFromFile(file);
		if (!scene) throw new Error(`Could not read ${file.path}.`);
		ea.reset();
		for (const el of mirrorElements(scene.elements.filter((e) => !e.isDeleted))) ea.elementsDict[el.id] = el;
		await this.saveDrawing(ea, folder, name, true);
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

	// Renames, duplicates or mirrors a library formation. A rename also renames the play folders named after it in every
	// playbook of that format, and updates those plays' embeds, subtitle and formation property.
	async moveFormation(file: TFile, format: string, side: Side, name: string, mode: "rename" | "duplicate" | "mirror") {
		const newPath = normalizePath(`${this.libraryFolder(format, side)}/${name}${DRAWING_EXT}`);
		if (this.app.vault.getAbstractFileByPath(newPath)) {
			new Notice(`Formation "${name}" already exists.`);
			return;
		}
		if (mode === "duplicate") {
			await this.app.vault.copy(file, newPath);
			return;
		}
		if (mode === "mirror") {
			const ea = this.ea();
			if (!ea) return;
			try {
				await this.writeMirror(ea, file, this.libraryFolder(format, side), name);
			} finally {
				ea.destroy?.();
			}
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

	async createPlaybook(name: string, format: string, sides: Side[]) {
		const folder = normalizePath(`${ROOT}/${name}`);
		if (this.app.vault.getAbstractFileByPath(folder)) {
			new Notice(`Playbook "${name}" already exists.`);
			return;
		}
		await ensureFolder(this.app, folder);
		await this.app.vault.create(
			`${folder}/Playbook.md`,
			`---\nformat: ${JSON.stringify(format)}\noffense: ${sides.includes("offense")}\ndefense: ${sides.includes("defense")}\n---\n# ${name}\n\nTeam notes go here.\n`
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

	// Renames, duplicates or mirrors a play's note and drawing, then points the note's embed at the new drawing.
	async movePlay(note: TFile, name: string, mode: "rename" | "duplicate" | "mirror") {
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
		if (mode === "mirror") {
			if (!drawing) {
				new Notice("This play has no drawing to mirror.");
				return;
			}
			const ea = this.ea();
			if (!ea) return;
			try {
				const copy = await this.app.vault.copy(note, newNote);
				await this.app.vault.process(copy, (text) => mirrorNote(text, drawing.path, newDrawing, oldName, name));
				await this.writeMirror(ea, drawing, folder, name);
			} finally {
				ea.destroy?.();
			}
			return;
		}
		let target = note;
		if (mode === "duplicate") {
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
		}
		await this.setPlaybookProperty(pb.folder, name);
	}

	// Sets the `playbook` property of every play note in a playbook folder.
	private async setPlaybookProperty(folder: TFolder, name: string) {
		const notes: TFile[] = [];
		Vault.recurseChildren(folder, (f) => {
			if (f instanceof TFile && f.extension === "md" && !f.name.endsWith(DRAWING_EXT) && f.name !== "Playbook.md") notes.push(f);
		});
		for (const note of notes) {
			await this.app.fileManager.processFrontMatter(note, (fm: Record<string, unknown>) => {
				if ("playbook" in fm) fm.playbook = name;
			});
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
		const file = await this.writeFile(path, content);
		await this.app.workspace.getLeaf("tab").openFile(file, { state: { mode: "preview" } });
		// Not public API. Obsidian only has this command where it can export PDFs, which may exclude mobile.
		const commands = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
		if (!commands?.executeCommandById("workspace:export-pdf")) {
			new Notice("PDF export isn't available on this device. Use a computer to export this playbook.");
		}
	}

	private async writeFile(path: string, text: string): Promise<TFile> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (!(existing instanceof TFile)) return this.app.vault.create(path, text);
		await this.app.vault.process(existing, () => text);
		return existing;
	}

	// Saves the whole playbook, plus the formation library of its format, as one file that others can import.
	async sharePlaybook(pb: Playbook) {
		const prefix = `${pb.folder.path}/`;
		const notes: TFile[] = [];
		Vault.recurseChildren(pb.folder, (f) => {
			if (f instanceof TFile && f.extension === "md") notes.push(f);
		});
		const files: Record<string, string> = {};
		for (const note of notes) {
			const path = note.path.slice(prefix.length);
			if (path !== "Export.md") files[path] = (await this.app.vault.read(note)).split(prefix).join(FOLDER_TOKEN);
		}
		const formations: Record<string, string> = {};
		for (const side of SIDES) {
			for (const file of this.formationFiles(pb.format, side)) formations[`${cap(side)}/${file.name}`] = await this.app.vault.read(file);
		}
		const pkg: PlaybookPackage = { type: PACKAGE_TYPE, version: PACKAGE_VERSION, name: pb.name, format: pb.format, files, formations };
		await this.saveFile(`${pb.name}.playbook.json`, JSON.stringify(pkg));
	}

	// Desktop: a download, which Obsidian turns into a save dialog. Mobile: the share sheet, or a file in the vault.
	private async saveFile(fileName: string, text: string) {
		const file = new File([text], fileName, { type: "application/json" });
		if (Platform.isMobile) {
			if (navigator.canShare?.({ files: [file] })) {
				try {
					await navigator.share({ files: [file] });
					return;
				} catch (e) {
					if (e instanceof DOMException && e.name === "AbortError") return; // the user closed the share sheet
				}
			}
			const path = normalizePath(`${ROOT}/${fileName}`);
			await this.writeFile(path, text);
			new Notice(`Saved ${path} in your vault. Send it to your team from there.`);
			return;
		}
		const url = URL.createObjectURL(file);
		createEl("a", { attr: { href: url, download: fileName } }).click();
		window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
		new Notice(`Send ${fileName} to your team. They add it with the import button in the playbooks panel.`);
	}

	// Asks for a playbook file and imports it. Works on desktop and mobile.
	pickImportFile() {
		const input = document.body.createEl("input", { attr: { type: "file", accept: ".json,application/json" } });
		input.hide();
		input.onchange = () => {
			const file = input.files?.[0];
			input.remove();
			if (file) void file.text().then((text) => this.importPlaybook(text)).catch(showError);
		};
		input.oncancel = () => input.remove();
		input.click();
	}

	async importPlaybook(text: string) {
		const { pkg, skipped } = parsePackage(text, Object.keys(FORMATS));
		const name = clean(pkg.name) || "Imported playbook";
		const existing = this.playbooks().find((p) => p.name === name);
		if (!existing) {
			const taken = this.app.vault.getAbstractFileByPath(normalizePath(`${ROOT}/${name}`)); // e.g. the formation library
			await this.writePackage(pkg, taken ? this.freeName(name) : name, skipped);
			return;
		}
		new ChoiceModal(
			this.app,
			`"${name}" already exists`,
			"Replace it with the imported version, or keep both. Replacing moves your current copy to the trash.",
			[
				{ text: "Keep both", run: () => this.writePackage(pkg, this.freeName(name), skipped) },
				{ text: "Replace", warning: true, run: () => this.writePackage(pkg, name, skipped, existing) },
			]
		).open();
	}

	private freeName(base: string): string {
		for (let i = 2; ; i++) {
			const name = `${base} ${i}`;
			if (!this.app.vault.getAbstractFileByPath(normalizePath(`${ROOT}/${name}`))) return name;
		}
	}

	// Writes a parsed playbook file into Playbooks/<name>, plus the formations this vault doesn't have yet.
	private async writePackage(pkg: PlaybookPackage, name: string, skipped: number, replace?: Playbook) {
		if (replace) await this.app.fileManager.trashFile(replace.folder);
		const folder = normalizePath(`${ROOT}/${name}`);
		for (const [path, text] of Object.entries(pkg.files)) {
			const target = normalizePath(`${folder}/${path}`);
			await ensureFolder(this.app, target.slice(0, target.lastIndexOf("/")));
			await this.app.vault.create(target, text.split(FOLDER_TOKEN).join(`${folder}/`));
		}
		const created = this.app.vault.getAbstractFileByPath(folder);
		if (name !== pkg.name && created instanceof TFolder) await this.setPlaybookProperty(created, name);

		// Built-in formations first (only seeds a library that doesn't exist yet), then the team's own.
		await this.ensureLibrary(pkg.format);
		let added = 0;
		for (const [path, text] of Object.entries(pkg.formations)) {
			const target = normalizePath(`${LIBRARY}/${pkg.format}/${path}`);
			if (this.app.vault.getAbstractFileByPath(target)) continue;
			await ensureFolder(this.app, target.slice(0, target.lastIndexOf("/")));
			await this.app.vault.create(target, text);
			added++;
		}
		await this.openManager();
		const extra = added ? ` with ${added} new formations` : "";
		new Notice(`Imported playbook "${name}"${extra}.${skipped ? ` Skipped ${skipped} unsafe files.` : ""}`);
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

// Field window: 20 yards downfield to 10 yards behind the line of scrimmage (y = 0). The primary side is at the bottom:
// for the offense downfield is up; for the defense the field is turned around, so downfield is down.
function drawField(ea: ExcalidrawAutomate, f: Format, primary: Side) {
	const half = (f.width / 2) * YD;
	const Y = (yards: number) => yards * YD * (primary === "offense" ? 1 : -1);
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
	ids.push(ea.addRect(-half - pad, Math.min(Y(-21), Y(11)), 2 * (half + pad), 32 * YD));
	Object.assign(ea.style, { strokeColor: "#adb5bd", roundness: null });

	line(-half, Y(-20), -half, Y(10));
	line(half, Y(-20), half, Y(10));
	for (let y = -20; y <= 10; y += 5) if (y) line(-half, Y(y), half, Y(y));
	if (f.hash) {
		for (let y = -20; y <= 10; y++) {
			for (const x of [-f.hash, f.hash]) line((x - 0.4) * YD, Y(y), (x + 0.4) * YD, Y(y));
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
			t.y = Y(y) - t.height / 2;
			ids.push(id);
		}
	}

	Object.assign(ea.style, { strokeColor: "#1971c2", strokeWidth: 2, strokeStyle: "dashed" });
	line(-half, 0, half, 0);

	for (const id of ids) ea.getElement(id).locked = true;
	ea.addToGroup(ids);
}

function drawPlayers(ea: ExcalidrawAutomate, side: Side, players: Player[], ghost: boolean, primary: Side) {
	const dir = primary === "offense" ? 1 : -1;
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
		// Offense-relative position (y > 0 is the offense backfield), turned around when the defense is at the bottom.
		const cx = x * YD * dir;
		const cy = (side === "offense" ? depth : -depth) * YD * dir;
		const shape = label === "C" && side === "offense" ? ea.addRect(cx - R, cy - R, 2 * R, 2 * R) : ea.addEllipse(cx - R, cy - R, 2 * R, 2 * R);
		ea.getElement(shape).customData = { playbook: { side, label, primary } };
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
		const newBook = top.createEl("button", { attr: { "aria-label": "New playbook" } });
		setIcon(newBook, "folder-plus");
		newBook.onclick = () => new PlaybookModal(this.plugin).open();
		const importBook = top.createEl("button", { attr: { "aria-label": "Import playbook" } });
		setIcon(importBook, "import");
		importBook.onclick = () => this.plugin.pickImportFile();

		const playbooks = this.plugin.playbooks();
		if (!playbooks.length) {
			const empty = el.createDiv({ cls: "pb-empty" });
			setIcon(empty.createDiv({ cls: "pb-empty-icon" }), "clipboard-list");
			empty.createDiv({ text: "No playbooks yet." });
			empty.createEl("button", { text: "Create a playbook", cls: "mod-cta" }).onclick = () => new PlaybookModal(this.plugin).open();
			empty.createEl("button", { text: "Import a playbook" }).onclick = () => this.plugin.pickImportFile();
			return;
		}

		for (const pb of playbooks) {
			const badge = pb.format.replace(" tackle", ""); // short, so the name has room next to the buttons
			const { summary, body } = this.section(el, `pb:${pb.name}`, pb.name, badge, playbooks.length === 1);
			const actions = summary.createSpan({ cls: "pb-actions" });
			const share = () => void this.plugin.sharePlaybook(pb).catch(showError);
			this.iconButton(actions, "plus", "New play", () => void this.plugin.newPlay(pb).catch(showError));
			this.iconButton(actions, "share-2", "Share playbook file", share);
			const menu = () =>
				this.itemMenu("playbook", pb.name, "All its plays, notes and drawings are moved to the trash.", {
					extras: [
						["Team notes", "file-text", () => {
							const notes = this.app.vault.getAbstractFileByPath(`${pb.folder.path}/Playbook.md`);
							this.openOrWarn(notes instanceof TFile ? notes : null);
						}],
						["Export PDF", "printer", () => void this.plugin.exportPdf(pb).catch(showError)],
						["Share playbook file", "share-2", share],
					],
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
									rename: (name) => this.plugin.movePlay(play, name, "rename"),
									duplicate: (name) => this.plugin.movePlay(play, name, "duplicate"),
									mirror: (name) => this.plugin.movePlay(play, name, "mirror"),
									remove: () => this.plugin.deletePlay(play),
								}),
							(rowActions) => {
								this.iconButton(rowActions, "file-text", "Open notes", () => this.openOrWarn(play));
								this.mirrorButton(rowActions, "play", play.basename, (name) => this.plugin.movePlay(play, name, "mirror"));
							}
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
			for (const side of SIDES.filter((s) => playbooks.some((p) => p.format === format && p[s]))) {
				lib.body.createDiv({ cls: "pb-group", text: cap(side) });
				const children = lib.body.createDiv({ cls: "pb-children" });
				for (const file of this.plugin.formationFiles(format, side)) {
					const mirror = (name: string) => this.plugin.moveFormation(file, format, side, name, "mirror");
					this.row(
						children,
						"users",
						drawingName(file),
						file,
						[file.path],
						() =>
							this.itemMenu("formation", drawingName(file), "Plays already made from it are not affected.", {
								rename: (name) => this.plugin.moveFormation(file, format, side, name, "rename"),
								duplicate: (name) => this.plugin.moveFormation(file, format, side, name, "duplicate"),
								mirror,
								remove: () => this.app.fileManager.trashFile(file),
							}),
						(rowActions) => this.mirrorButton(rowActions, "formation", drawingName(file), mirror)
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

	askName(title: string, value: string, run: (name: string) => Promise<void>) {
		new NameModal(this.app, title, value, (name) => run(name).catch(showError)).open();
	}

	mirrorButton(parent: HTMLElement, kind: string, current: string, mirror: (name: string) => Promise<void>) {
		this.iconButton(parent, "flip-horizontal-2", "Mirror to the other side", () =>
			this.askName(`Mirror ${kind}`, mirroredName(current), mirror)
		);
	}

	itemMenu(
		kind: string,
		current: string,
		deleteNote: string,
		actions: {
			extras?: [title: string, icon: string, run: () => void][];
			rename: (name: string) => Promise<void>;
			duplicate?: (name: string) => Promise<void>;
			mirror?: (name: string) => Promise<void>;
			remove: () => Promise<void>;
		}
	): Menu {
		const menu = new Menu();
		const { extras = [], rename, duplicate, mirror, remove } = actions;
		for (const [title, icon, run] of extras) menu.addItem((item) => item.setTitle(title).setIcon(icon).onClick(run));
		if (extras.length) menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Rename")
				.setIcon("pencil-line")
				.onClick(() => this.askName(`Rename ${kind}`, current, rename))
		);
		if (duplicate) {
			menu.addItem((item) =>
				item
					.setTitle("Duplicate")
					.setIcon("copy")
					.onClick(() => this.askName(`Duplicate ${kind}`, `${current} copy`, duplicate))
			);
		}
		if (mirror) {
			menu.addItem((item) =>
				item
					.setTitle("Mirror to the other side")
					.setIcon("flip-horizontal-2")
					.onClick(() => this.askName(`Mirror ${kind}`, mirroredName(current), mirror))
			);
		}
		menu.addItem((item) =>
			item
				.setTitle("Delete")
				.setIcon("trash")
				.setWarning(true)
				.onClick(() =>
					new ChoiceModal(this.app, `Delete "${current}"?`, deleteNote, [{ text: "Delete", warning: true, run: remove }]).open()
				)
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
	sides = "both";

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
			.setName("Sides")
			.setDesc("Defense plays are drawn with the defense at the bottom.")
			.addDropdown((d) =>
				d
					.addOptions({ both: "Offense and defense", offense: "Offense only", defense: "Defense only" })
					.setValue(this.sides)
					.onChange((v) => (this.sides = v))
			);
		new Setting(this.contentEl).addButton((b) => b.setButtonText("Create").setCta().onClick(() => this.submit()));
	}

	submit() {
		if (!clean(this.name)) return void new Notice("Enter a name.");
		this.close();
		const sides = this.sides === "both" ? SIDES : [this.sides as Side];
		void this.plugin.createPlaybook(clean(this.name), this.format, sides).catch(showError);
	}
}

class PlayModal extends FormModal {
	pb: Playbook;
	side: Side;
	formation = "";
	opponent = "";
	name = "";

	constructor(private plugin: PlaybookPlugin, pb?: Playbook) {
		super(plugin.app);
		this.pb = pb ?? plugin.playbooks()[0];
		this.side = sidesOf(this.pb)[0];
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
				if (!sidesOf(this.pb).includes(this.side)) this.side = sidesOf(this.pb)[0];
				this.opponent = "";
				this.render();
			});
		});
		if (sidesOf(this.pb).length > 1) {
			new Setting(el).setName("Side").addDropdown((d) => {
				for (const s of sidesOf(this.pb)) d.addOption(s, cap(s));
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
		new Setting(el)
			.setName(`Against ${other(this.side)} formation`)
			.setDesc("Optional. Drawn faded at the top so you can see the matchup.")
			.addDropdown((d) => {
				d.addOption("", "None");
				for (const f of this.plugin.formationFiles(this.pb.format, other(this.side)).map(drawingName)) d.addOption(f, f);
				d.setValue(this.opponent).onChange((v) => (this.opponent = v));
			});
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

interface Choice {
	text: string;
	warning?: boolean;
	run: () => Promise<void>;
}

// A question with Cancel plus one or more answers.
class ChoiceModal extends Modal {
	constructor(app: App, private title: string, private message: string, private choices: Choice[]) {
		super(app);
	}

	onOpen() {
		this.titleEl.setText(this.title);
		this.contentEl.createEl("p", { text: this.message });
		const buttons = new Setting(this.contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		for (const choice of this.choices) {
			buttons.addButton((b) => {
				b.setButtonText(choice.text).onClick(() => {
					this.close();
					void choice.run().catch(showError);
				});
				// mod-warning class instead of setWarning() (deprecated) or setDestructive() (needs Obsidian 1.13).
				if (choice.warning) b.buttonEl.addClass("mod-warning");
				else b.setCta();
			});
		}
	}
}

class PlaybookSuggest extends FuzzySuggestModal<Playbook> {
	constructor(private plugin: PlaybookPlugin, private choose: (pb: Playbook) => void) {
		super(plugin.app);
		this.setPlaceholder("Choose a playbook");
	}
	getItems() {
		return this.plugin.playbooks();
	}
	getItemText(pb: Playbook) {
		return pb.name;
	}
	onChooseItem(pb: Playbook) {
		this.choose(pb);
	}
}
