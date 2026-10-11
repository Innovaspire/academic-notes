import { Modal, Setting, Notice, TFile, MarkdownView } from 'obsidian';
import type AcademicNotes from '../main';
import Engine from '../indexing/engine';
import { t } from '../i18n';
import { auditReferences, auditLabel, type AuditIssue } from '../workspace/audit';
import { CATALOG_START, CATALOG_END, catalogBody, readCatalog, renderCatalog, updateCatalog, type CatalogOptions } from '../workspace/catalog';
import { exportProfile, parseProfile, mergeProfile, profileSummary } from '../workspace/profiles';
import { paletteOptions } from '../rendering/palettes';

type Scope = CatalogOptions['scope'];
function scopeOptions() { return { note: t('当前笔记'), folder: t('当前文件夹及子文件夹'), vault: t('整个库'), book: t('当前 phb-book 清单') }; }
async function scopedPaths(plugin: AcademicNotes, scope: Scope, source: string) {
    const paths = [...plugin.graph!.notes.keys()].sort((a, b) => a.localeCompare(b));
    if (scope === 'vault') return new Set(paths);
    if (scope === 'folder') { const folder = source.slice(0, source.lastIndexOf('/') + 1); return new Set(paths.filter(path => path.startsWith(folder))); }
    if (scope === 'book') {
        const file = plugin.app.vault.getAbstractFileByPath(source);
        if (!(file instanceof TFile)) throw new Error(t('目标笔记不存在'));
        const selection = await plugin.resolveSelection(true, file);
        return new Set(selection.files.map(entry => entry.file.path));
    }
    if (!plugin.graph!.notes.has(source)) throw new Error(t('当前笔记未参与索引。'));
    return new Set([source]);
}
async function openLine(plugin: AcademicNotes, issue: { path: string; line: number }) {
    const file = plugin.app.vault.getAbstractFileByPath(issue.path);
    if (!(file instanceof TFile)) throw new Error(t('目标笔记不存在'));
    const leaf = plugin.app.workspace.getLeaf(false);
    await leaf.openFile(file, { active: true, eState: { line: issue.line } });
    if (leaf.view instanceof MarkdownView) {
        leaf.view.setEphemeralState({ line: issue.line });
        if (leaf.view.getMode() === 'source') { const from = { line: issue.line, ch: 0 }; leaf.view.editor.setCursor(from); leaf.view.editor.scrollIntoView({ from, to: from }, true); }
    }
}
export class ReferenceAuditModal extends Modal {
    private selectionScope: Scope = 'note';
    private source: string;
    private results: HTMLElement;
    private filter = '';
    private issues: AuditIssue[] = [];
    constructor(private plugin: AcademicNotes) { super(plugin.app); this.source = plugin.app.workspace.getActiveFile()?.path || ''; if (!this.source) this.selectionScope = 'vault'; }
    onOpen() {
        this.titleEl.setText(t('检查学术引用'));
        this.contentEl.createEl('p', { text: t('检查块引用、重复标签、手动编号冲突和合订本范围；不会修改笔记。') });
        new Setting(this.contentEl).setName(t('检查范围')).addDropdown(d => d.addOptions(scopeOptions()).setValue(this.selectionScope).onChange(value => { this.selectionScope = value as Scope; }))
            .addButton(b => b.setButtonText(t('开始检查')).setCta().onClick(async () => {
                b.setDisabled(true);
                try {
                    await this.plugin.rebuild();
                    const paths = await scopedPaths(this.plugin, this.selectionScope, this.source);
                    this.issues = auditReferences(this.plugin.graph!, { paths, book: this.selectionScope === 'book',
                        resolve: (name, here) => this.plugin.resolver(name, here),
                        externalBlock: (path, id) => { const file = this.app.vault.getAbstractFileByPath(path); return file instanceof TFile && !!this.app.metadataCache.getFileCache(file)?.blocks?.[id]; }
                    });
                    this.showResults();
                } catch (error) { this.plugin.fail(t('检查学术引用'), error); }
                finally { b.setDisabled(false); }
            }));
        new Setting(this.contentEl).setName(t('筛选结果')).addText(input => input.onChange(value => { this.filter = value.toLocaleLowerCase(); this.showResults(); }));
        this.results = this.contentEl.createDiv({ cls: 'an-tool-results' });
        this.results.createEl('p', { text: t('选择范围后开始检查。') });
    }
    private showResults() {
        this.results.empty();
        const visible = this.issues.filter(issue => [issue.path, issue.detail, auditLabel(issue.code)].join(' ').toLocaleLowerCase().includes(this.filter));
        this.results.createEl('p', { text: this.issues.length ? t('发现 {0} 项，当前显示 {1} 项。', this.issues.length, Math.min(visible.length, 200)) : t('未发现块引用或编号冲突。') });
        for (const issue of visible.slice(0, 200)) {
            const row = new Setting(this.results).setName(auditLabel(issue.code)).setDesc(`${issue.path}:${issue.line + 1} · ${issue.detail}`);
            row.addButton(b => b.setButtonText(t('定位')).onClick(() => { this.close(); void openLine(this.plugin, issue).catch(e => this.plugin.fail(t('打开块引用'), e)); }));
            if (issue.related) row.addButton(b => b.setButtonText(t('另一处')).onClick(() => { this.close(); void openLine(this.plugin, issue.related!).catch(e => this.plugin.fail(t('打开块引用'), e)); }));
        }
        if (visible.length > 200) this.results.createEl('p', { text: t('结果较多，请用筛选缩小范围。') });
    }
}
function notePath(raw: string) {
    const path = raw.trim().replace(/\\/g, '/');
    // eslint-disable-next-line no-control-regex -- A generated file must remain within the vault.
    if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.')) || /[<>:"|?*#[\]\x00-\x1f]/.test(path))
        throw new Error(t('请填写库内 Markdown 路径，不允许绝对路径或隐藏目录。'));
    return /\.md$/i.test(path) ? path : path + '.md';
}
function indexEditor(plugin: AcademicNotes, file: TFile) {
    return plugin.app.workspace.getLeavesOfType?.('markdown').map(leaf => leaf.view).find((view): view is MarkdownView => view instanceof MarkdownView && view.file?.path === file.path && view.getMode() === 'source')?.editor;
}
async function writeIndex(plugin: AcademicNotes, file: TFile, options: CatalogOptions, body: string, checkConfig = false) {
    const update = (current: string) => {
        if (checkConfig && JSON.stringify(readCatalog(current)) !== JSON.stringify(options)) throw new Error(t('索引配置已变化，请重试。'));
        return updateCatalog(current, options, body);
    };
    const editor = indexEditor(plugin, file);
    if (editor) {
        // Update the editor's current buffer so unsaved handwriting survives and the
        // generated-region edit is undoable. Never replace the whole editor document.
        const current = editor.getValue(), next = update(current), start = current.indexOf(CATALOG_START);
        const end = current.indexOf(CATALOG_END) + CATALOG_END.length, nextEnd = next.indexOf(CATALOG_END) + CATALOG_END.length;
        editor.replaceRange(next.slice(start, nextEnd), editor.offsetToPos(start), editor.offsetToPos(end));
    } else await plugin.app.vault.process(file, update);
}
export class CatalogModal extends Modal {
    private options: CatalogOptions;
    private destination = 'Academic index.md';
    private preview: HTMLElement;
    private generation = 0;
    constructor(private plugin: AcademicNotes) {
        super(plugin.app);
        this.options = { version: 1, scope: plugin.app.workspace.getActiveFile() ? 'note' : 'vault', source: plugin.app.workspace.getActiveFile()?.path || '',
            types: [...Object.keys(Engine.TYPES).filter(key => !['proof', 'remark', 'solution'].includes(key)), ...Object.keys(Engine.MEDIA), 'equation', ...Object.keys(Engine.environments(plugin.settings))], group: 'type', unnumbered: true };
    }
    onOpen() {
        this.titleEl.setText(t('生成学术索引笔记'));
        this.contentEl.createEl('p', { text: t('生成普通 Markdown 链接，可直接在库内使用。只更新生成区域，区域外的手写内容保留。无块标签时链接到所在章节。') });
        new Setting(this.contentEl).setName(t('索引范围')).addDropdown(d => d.addOptions(scopeOptions()).setValue(this.options.scope).onChange(value => { this.options.scope = value as Scope; }));
        new Setting(this.contentEl).setName(t('索引笔记路径')).addText(input => input.setValue(this.destination).onChange(value => { this.destination = value; }));
        new Setting(this.contentEl).setName(t('分组方式')).addDropdown(d => d.addOptions({ type: t('按环境类型'), file: t('按来源笔记') }).setValue(this.options.group).onChange(value => { this.options.group = value as 'type' | 'file'; }));
        new Setting(this.contentEl).setName(t('包含未编号的环境')).addToggle(toggle => toggle.setValue(true).onChange(value => { this.options.unnumbered = value; }));
        const details = this.contentEl.createEl('details', { cls: 'an-settings-details' }); details.createEl('summary', { text: t('选择环境类型') });
        for (const key of [...Object.keys(Engine.TYPES), ...Object.keys(Engine.MEDIA), 'equation', ...Object.keys(Engine.environments(this.plugin.settings))]) {
            new Setting(details).setName(Engine.labelName(key, this.plugin.settings)).addToggle(toggle => toggle.setValue(this.options.types.includes(key)).onChange(value => {
                this.options.types = value ? [...this.options.types, key] : this.options.types.filter(type => type !== key);
            }));
        }
        new Setting(this.contentEl).addButton(b => b.setButtonText(t('预览索引')).onClick(async () => {
            const generation = ++this.generation; b.setDisabled(true);
            try { const { body } = await this.prepare(); if (generation === this.generation) { this.preview.empty(); this.preview.createEl('pre', { cls: 'an-diagnostics', text: body }); } }
            catch (error) { this.plugin.fail(t('生成学术索引笔记'), error); } finally { b.setDisabled(false); }
        })).addButton(b => b.setButtonText(t('生成或更新')).setCta().onClick(async () => {
            b.setDisabled(true);
            try {
                const { destination, options, body } = await this.prepare();
                const existing = this.app.vault.getAbstractFileByPath(destination);
                if (existing && !(existing instanceof TFile)) throw new Error(t('该路径已存在，请选择新的笔记路径。'));
                if (existing instanceof TFile) {
                    await writeIndex(this.plugin, existing, options, body);
                    await this.app.workspace.getLeaf('tab').openFile(existing);
                } else {
                    const folder = destination.slice(0, destination.lastIndexOf('/')); if (folder) await this.plugin.mkdir(folder);
                    const file = await this.app.vault.create(destination, '# ' + t('学术索引') + '\n\n' + renderCatalog(options, body) + '\n');
                    await this.app.workspace.getLeaf('tab').openFile(file);
                }
                this.close(); new Notice(t('学术索引已保存。'));
            } catch (error) { this.plugin.fail(t('生成学术索引笔记'), error); } finally { b.setDisabled(false); }
        }));
        this.preview = this.contentEl.createDiv();
    }
    private async prepare() {
        const options = { ...this.options, types: [...this.options.types] }, destination = notePath(this.destination);
        await this.plugin.rebuild();
        const body = catalogBody(this.plugin.graph!, options, await scopedPaths(this.plugin, options.scope, options.source), destination);
        return { options, destination, body };
    }
}
export async function refreshCatalog(plugin: AcademicNotes) {
    const file = plugin.app.workspace.getActiveFile(); if (!(file instanceof TFile)) throw new Error(t('请先打开一篇 Markdown 笔记。'));
    const source = indexEditor(plugin, file)?.getValue() ?? await plugin.app.vault.read(file), options = readCatalog(source);
    if (!options) throw new Error(t('当前笔记不是 Academic Notes 生成的索引。'));
    await plugin.rebuild();
    const body = catalogBody(plugin.graph!, options, await scopedPaths(plugin, options.scope, options.source), file.path);
    await writeIndex(plugin, file, options, body, true);
    new Notice(t('学术索引已更新；手写内容保留。'));
}
export class ProfileModal extends Modal {
    private input: HTMLTextAreaElement;
    private preview: HTMLElement;
    private replace = false;
    private activate = false;
    private reviewed = '';
    private reviewedSettings = '';
    constructor(private plugin: AcademicNotes, private onApplied: () => void = () => {}) { super(plugin.app); }
    onOpen() {
        this.titleEl.setText(t('分享配色与环境方案'));
        this.contentEl.createEl('p', { text: t('方案仅包含配色、图标、环境名称和引用格式。导出不包含笔记、目录路径、诊断或导出设置。') });
        this.input = this.contentEl.createEl('textarea', { cls: 'an-profile-input', attr: { rows: '9', spellcheck: 'false', 'aria-label': t('方案 JSON') } });
        this.input.addEventListener('input', () => { this.reviewed = ''; this.preview.empty(); });
        const fileInput = this.contentEl.createEl('input', { attr: { type: 'file', accept: '.json,application/json', hidden: '' } });
        fileInput.addEventListener('change', () => { void (async () => {
            const file = fileInput.files?.[0]; if (!file) return;
            if (file.size > 2100000) throw new Error(t('方案文件过大，最多允许 700 KB 文本。'));
            this.input.value = await file.text(); this.reviewed = ''; this.preview.empty();
        })().catch(error => this.plugin.fail(t('导入方案'), error)); });
        new Setting(this.contentEl).addButton(b => b.setButtonText(t('载入 JSON 文件')).onClick(() => fileInput.click()))
            .addButton(b => b.setButtonText(t('填入当前方案')).onClick(() => { this.input.value = exportProfile(this.plugin.settings); this.reviewed = ''; this.preview.empty(); }))
            .addButton(b => b.setButtonText(t('保存当前方案到库内')).onClick(async () => {
                try { const folder = this.plugin.settings.exportFolder; await this.plugin.mkdir(folder); const path = folder.replace(/\/$/, '') + '/academic-style-' + Date.now() + '.json'; await this.app.vault.adapter.write(path, exportProfile(this.plugin.settings)); new Notice(t('已保存 ') + path, 12000); }
                catch (error) { this.plugin.fail(t('导出方案'), error); }
            }));
        new Setting(this.contentEl).setName(t('同名项目处理')).addDropdown(d => d.addOptions({ keep: t('保留本地项目'), replace: t('使用导入项目') }).onChange(value => { this.replace = value === 'replace'; this.reviewed = ''; }));
        new Setting(this.contentEl).setName(t('同时采用方案的默认配色和引用选项')).setDesc(t('关闭时只合并环境和配色定义，保留当前选中的浅色与深色方案。')).addToggle(toggle => toggle.setValue(false).onChange(value => { this.activate = value; this.reviewed = ''; }));
        new Setting(this.contentEl).addButton(b => b.setButtonText(t('预览导入')).onClick(() => {
            try {
                const profile = parseProfile(this.input.value), next = mergeProfile(this.plugin.settings, profile, this.replace, this.activate);
                const entries = profileSummary(profile, this.plugin.settings); this.preview.empty();
                this.preview.createEl('p', { text: t('导入后的默认配色：浅色 {0}；深色 {1}。', paletteOptions(next, 'light')[next.lightPalette], paletteOptions(next, 'dark')[next.darkPalette]) });
                this.preview.createEl('p', { text: t('方案含 {0} 个项目，其中 {1} 个与本地同名。', entries.length, entries.filter(entry => entry.conflict).length) });
                const list = this.preview.createEl('ul');
                for (const entry of entries.slice(0, 100)) list.createEl('li', { text: entry.name + (entry.conflict ? ' · ' + t(this.replace ? '使用导入项目' : '保留本地项目') : '') });
                this.reviewed = this.input.value;
                this.reviewedSettings = exportProfile(this.plugin.settings);
            } catch (error) { this.reviewed = ''; this.plugin.fail(t('导入方案'), error); }
        })).addButton(b => b.setButtonText(t('应用导入')).setCta().onClick(async () => {
            if (!this.reviewed || this.reviewed !== this.input.value || this.reviewedSettings !== exportProfile(this.plugin.settings)) { new Notice(t('请先预览此方案及同名项目的处理方式。')); return; }
            const previous = this.plugin.settings; b.setDisabled(true);
            try {
                this.plugin.settings = mergeProfile(previous, parseProfile(this.input.value), this.replace, this.activate);
                await this.plugin.saveSettings(); this.onApplied(); this.close(); new Notice(t('方案已导入。'));
            } catch (error) { this.plugin.settings = previous; this.plugin.applyAppearance(); this.plugin.fail(t('导入方案'), error); }
            finally { b.setDisabled(false); }
        }));
        this.preview = this.contentEl.createDiv({ cls: 'an-tool-results' });
    }
}
