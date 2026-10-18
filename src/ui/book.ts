import { Modal, Setting, Notice, TFile, Platform } from 'obsidian';
import type AcademicNotes from '../main';
import type { ExportSelection } from '../main';
import { editNote, saveBookSource } from '../workspace/notes';
import { auditReferences, auditLabel } from '../workspace/audit';
import { notePath } from './workspace-tools';
import { t } from '../i18n';

export class BookPicker extends Modal {
    selected: TFile[] = [];
    titles = new Map<string, string>();
    title = t('数学讲义'); subtitle = ''; depth: number;
    destination = 'Book.md'; manifest?: TFile;
    private form: HTMLElement;
    private fileList: HTMLElement;
    private orderList: HTMLElement;
    private filter = '';
    private saving = false;
    constructor(private plugin: AcademicNotes) { super(plugin.app); this.depth = plugin.settings.tocDepth; }
    onOpen() {
        this.titleEl.setText(t('多文件合订本'));
        this.form = this.contentEl.createDiv(); this.draw();
        const file = this.app.workspace.getActiveFile();
        if (file && this.app.metadataCache.getFileCache(file)?.frontmatter?.['phb-book']) void this.load(file).catch(e => this.plugin.fail(t('载入合订本清单'), e));
    }
    private async load(file: TFile) {
        const selection = await this.plugin.resolveSelection(true, file);
        this.manifest = file; this.destination = file.path;
        this.selected = selection.files.map(x => x.file); this.titles = new Map(selection.files.map(x => [x.file.path, x.title]));
        this.title = selection.options.title; this.subtitle = selection.options.subtitle; this.depth = selection.options.tocDepth;
        this.draw();
    }
    private draw() {
        this.form.empty();
        new Setting(this.form).setName(t('合订本标题')).addText(c => c.setValue(this.title).onChange(v => this.title = v));
        new Setting(this.form).setName(t('副标题')).addText(c => c.setValue(this.subtitle).onChange(v => this.subtitle = v));
        new Setting(this.form).setName(t('目录深度')).addDropdown(c => c.addOptions(Object.fromEntries([1,2,3,4,5,6].map(n => [n, String(n)]))).setValue(String(this.depth)).onChange(v => this.depth = Number(v)));
        new Setting(this.form).setName(t('清单笔记路径')).addText(c => c.setValue(this.destination).onChange(v => this.destination = v));
        new Setting(this.form).addButton(b => b.setButtonText(t('载入合订本清单')).onClick(async () => {
            try { const file = this.app.vault.getAbstractFileByPath(notePath(this.destination)); if (!(file instanceof TFile)) throw new Error(t('目标笔记不存在')); await this.load(file); }
            catch (e) { this.plugin.fail(t('载入合订本清单'), e); }
        })).addButton(b => b.setButtonText(t('保存清单')).onClick(async () => {
            if (this.saving) return; this.saving = true; b.setDisabled(true);
            try {
                const selection = this.selection(), destination = notePath(this.destination);
                if (selection.files.some(x => x.file.path === destination)) throw new Error(t('清单不能包含自身作为章节。'));
                const book = { title: selection.options.title, subtitle: this.subtitle, tocDepth: this.depth, files: selection.files.map(x => ({ path: x.file.path, title: x.title })) };
                const file = this.app.vault.getAbstractFileByPath(destination);
                if (file instanceof TFile) { await editNote(this.plugin, file, text => saveBookSource(text, book, true)); this.manifest = file; }
                else { if (file) throw new Error(t('该路径已存在，请选择新的笔记路径。')); const folder = destination.slice(0, destination.lastIndexOf('/')); if (folder) await this.plugin.mkdir(folder); this.manifest = await this.app.vault.create(destination, saveBookSource('', book)); }
                new Notice(t('合订本清单已保存。'));
            } catch (e) { this.plugin.fail(t('保存清单'), e); }
            finally { this.saving = false; b.setDisabled(false); }
        }));
        new Setting(this.form).setName(t('筛选章节')).addText(c => c.setValue(this.filter).onChange(v => { this.filter = v; this.renderFiles(); }));
        this.fileList = this.form.createDiv({ cls: 'an-book-files' }); this.orderList = this.form.createDiv({ cls: 'an-book-order' });
        const actions = new Setting(this.form).addButton(b => b.setButtonText(t('检查学术引用')).onClick(() => { void this.check().catch(e => this.plugin.fail(t('检查学术引用'), e)); }));
        actions.addButton(b => b.setButtonText(t('生成 HTML 快照')).onClick(() => { void this.check(false).catch(e => this.plugin.fail(t('导出'), e)); }));
        if (Platform.isDesktopApp) actions.addButton(b => b.setButtonText(t('导出 PDF')).setCta().onClick(() => { void this.check(true).catch(e => this.plugin.fail(t('导出'), e)); }));
        this.renderFiles(); this.renderOrder();
    }
    private selection(): ExportSelection {
        if (!this.selected.length) throw new Error(t('请至少选一篇笔记。'));
        return { files: this.selected.map(file => ({ file, title: this.titles.get(file.path) || file.basename })), options: { book: true, title: this.title.trim() || t('数学讲义'), subtitle: this.subtitle, tocDepth: this.depth } };
    }
    private async check(pdf?: boolean) {
        const selection = this.selection();
        if (pdf === undefined) await reviewBookReferences(this.plugin, selection, false);
        else { this.close(); await this.plugin.exportSelection(selection, pdf); }
    }
    renderFiles() {
        this.fileList.empty();
        const files = this.app.vault.getMarkdownFiles().filter(f => f.path !== this.manifest?.path && f.path.toLowerCase().includes(this.filter.toLowerCase())).sort((a,b) => a.path.localeCompare(b.path));
        for (const file of files.slice(0, 250)) {
            const label = this.fileList.createEl('label', { cls: 'an-file-choice' }), input = label.createEl('input', { type: 'checkbox' });
            input.checked = this.selected.some(f => f.path === file.path); label.createSpan({ text: file.path });
            input.addEventListener('change', () => { if (input.checked) this.selected.push(file); else this.selected = this.selected.filter(f => f.path !== file.path); this.renderOrder(); });
        }
        if (files.length > 250) this.fileList.createEl('p', { text: t('只显示前 250 个结果，请继续输入路径筛选。') });
    }
    renderOrder() {
        this.orderList.empty(); this.orderList.createEl('h4', { text: t('章节顺序 · {0} 篇', this.selected.length) });
        this.selected.forEach((file, i) => {
            const row = new Setting(this.orderList).setName(`${i + 1}. ${file.path}`).addText(c => c.setValue(this.titles.get(file.path) || file.basename).onChange(v => this.titles.set(file.path, v)));
            for (const [label, delta] of [[t('上移'), -1], [t('下移'), 1]] as const) row.addButton(b => b.setButtonText(label).setDisabled(i + delta < 0 || i + delta >= this.selected.length).onClick(() => { [this.selected[i], this.selected[i + delta]] = [this.selected[i + delta], this.selected[i]]; this.renderOrder(); }));
            row.addButton(b => b.setButtonText(t('移除')).onClick(() => { this.selected.splice(i, 1); this.renderFiles(); this.renderOrder(); }));
        });
    }
}

export async function reviewBookReferences(plugin: AcademicNotes, selection: ExportSelection, forExport = true): Promise<boolean> {
    await plugin.rebuild();
    const issues = auditReferences(plugin.graph!, {paths:new Set(selection.files.map(x => x.file.path)),book:true,resolve:(n,h)=>plugin.resolver(n,h)});
    for (const {file} of selection.files) if (!plugin.graph!.notes.has(file.path)) issues.push({code:'excluded-file',path:file.path,line:0,detail:file.path});
    if (forExport && !issues.length) return true;
    return new Promise(resolve => {
        const modal = new Modal(plugin.app); let accepted = false;
        modal.titleEl.setText(t('检查学术引用'));
        modal.contentEl.createEl('p', {text:issues.length ? t('发现 {0} 项，请检查后再导出。',issues.length) : t('未发现块引用或编号冲突。')});
        for (const issue of issues.slice(0,150)) modal.contentEl.createEl('p',{text:`${auditLabel(issue.code)} · ${issue.path}:${issue.line + 1} · ${issue.detail}`});
        modal.onClose = () => resolve(accepted);
        if (forExport) new Setting(modal.contentEl).addButton(b=>b.setButtonText(t('取消')).onClick(()=>modal.close())).addButton(b=>b.setButtonText(t('仍然导出')).onClick(()=>{accepted=true;modal.close();}));
        modal.open();
    });
}
