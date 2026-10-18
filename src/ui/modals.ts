import { BookPicker } from './book';
import { t } from '../i18n';
import { environmentTemplate } from './environment';
import type { FigureLayout } from '../rendering/figure-layout';
import type AcademicNotes from '../main';
import type { SourceRecord } from '../indexing/engine';
import type { App, Editor, TFile, EditorPosition, EditorSuggestContext } from 'obsidian';
import { Modal, FuzzySuggestModal, EditorSuggest, Setting, Notice } from 'obsidian';
import Engine from '../indexing/engine';
class ProgressModal extends Modal {
    caption: string;
    output?: HTMLPreElement;
    cancelButton?: HTMLButtonElement;
    constructor(app: App, title: string, private cancel?: () => void) { super(app); this.caption = title; }
    onOpen() { this.titleEl.setText(this.caption); this.output = this.contentEl.createEl('pre', { cls: 'an-progress', text: '' }); this.contentEl.createEl('p', { text: t("关闭窗口不会中断任务；输出仍保存到指定目录。") }); if (this.cancel) { this.cancelButton = this.contentEl.createEl('button', {text:t('取消导出')}); this.cancelButton.addEventListener('click', () => { this.cancelButton!.disabled = true; this.cancel!(); this.line(t('正在取消…')); }); } }
    line(s: string) { if (this.output) {
        this.output.textContent = (this.output.textContent + '\n' + s).slice(-35000);
        this.output.scrollTop = this.output.scrollHeight;
    } }
    done() { if (this.cancelButton) this.cancelButton.disabled = true; if (this.titleEl)
        this.titleEl.setText(this.caption + t(" · 结束")); }
}
class ReferencePicker extends FuzzySuggestModal<SourceRecord> {
    plugin: AcademicNotes;
    editor: Editor;
    file: TFile | null;
    constructor(plugin: AcademicNotes, editor: Editor, file: TFile | null) { super(plugin.app); this.plugin = plugin; this.editor = editor; this.file = file; this.setPlaceholder(t("搜索所有环境；选择无标签对象会添加标签并引用")); }
    getItems() { return this.plugin.targets(false); }
    getItemText(r: SourceRecord) { return `${Engine.refText(r, this.plugin.settings) || Engine.labelName(r.key, this.plugin.settings)} ${r.title || r.tex || ''} — ${r.path} ${r.id ? '^' + r.id : t('添加标签并引用')}`; }
    onChooseItem(r: SourceRecord) { if (!this.file)
        return; void this.plugin.insertReference(this.editor, this.file, r).catch(e => this.plugin.fail(t('插入引用'), e)); }
}
class ReferenceSuggest extends EditorSuggest<SourceRecord> {
    plugin: AcademicNotes;
    kind = '';
    constructor(plugin: AcademicNotes) { super(plugin.app); this.plugin = plugin; this.limit = 30; }
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null) {
        if (!file)
            return null;
        const before = editor.getLine(cursor.line).slice(0, cursor.ch), m = before.match(/\\(eqref|tref|ref)(?:\s+([^\n]*))?$/);
        if (!m)
            return null;
        this.kind = m[1];
        return { start: { line: cursor.line, ch: cursor.ch - m[0].length }, end: cursor, query: m[2] || '' };
    }
    getSuggestions(ctx: EditorSuggestContext) { const q = ctx.query.toLowerCase(); return this.plugin.targets(false).filter(r => (this.kind !== 'eqref' || r.kind === 'equation') && (this.kind !== 'tref' || r.kind === 'theorem')).filter(r => (Engine.refText(r, this.plugin.settings) + ' ' + r.path + ' ' + (r.title || r.tex)).toLowerCase().includes(q)).slice(0, 30); }
    renderSuggestion(r: SourceRecord, el: HTMLElement) { el.createDiv({ text: Engine.refText(r, this.plugin.settings) || Engine.labelName(r.key, this.plugin.settings), cls: 'an-suggest-title' }); el.createDiv({ text: (r.title || r.tex || '').slice(0, 130) + ' — ' + r.path + (r.id ? '' : ' · ' + t('添加标签并引用')), cls: 'an-suggest-detail' }); }
    selectSuggestion(r: SourceRecord) { const c = this.context; if (!c?.file)
        return; this.close(); void this.plugin.insertReference(c.editor, c.file, r, c.start, c.end).catch(e => this.plugin.fail(t('插入引用'), e)); }
}
class EnvironmentModal extends Modal {
    constructor(app: App, private editor: Editor, private customEnvironments: Record<string, import("../indexing/environments").CustomEnvironment> = {}) { super(app); }
    onOpen() {
        this.titleEl.setText(t('插入学术环境'));
        this.contentEl.createEl('p', { text: t('在当前行前插入完整环境，保留原文；插入后直接填写选中的标题。') });
        let kind = 'subfigures', count = 2, columns: FigureLayout['columns'] = 'auto', height = '';
        let group: HTMLDivElement;
        new Setting(this.contentEl).setName(t('环境类型')).addDropdown(d => d.addOptions({
            thm: t('定理'), def: t('定义'), proof: t('证明'), remark: t('注记'), figure: t('单图'), subfigures: t('子图组'), table: t('表格'), algorithm: t('算法（Callout）'), 'algorithm-fence': t('算法（代码块）'), tikz: 'TikZ (TikZJax)', ...Object.fromEntries(Object.entries(this.customEnvironments).filter(([, entry]) => !entry.retired).map(([key, entry]) => [key, entry.name]))
        }).setValue(kind).onChange(v => { kind = v; group.hidden = kind !== 'subfigures'; }));
        group = this.contentEl.createDiv();
        new Setting(group).setName(t('子图数量')).addDropdown(d => d.addOptions(Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i + 2), String(i + 2)]))).setValue('2').onChange(v => { count = Number(v); }));
        new Setting(group).setName(t('最大列数')).setDesc(t('自动：四幅最多四列，其余最多三列；窄窗格会减少列数，四列直接变两列。')).addDropdown(d => d.addOptions({ auto: t('自动'), '1': '1', '2': '2', '3': '3', '4': '4' }).setValue('auto').onChange(v => { columns = v === 'auto' ? v : Number(v) as 1 | 2 | 3 | 4; }));
        new Setting(group).setName(t('统一图片高度（像素）')).setDesc(t('留空保留各图片宽度；设置后整组等高，不拉伸、不裁剪，空间不足时整组统一缩小。')).addText(c => c.setPlaceholder('180').onChange(v => { height = v.trim(); }));
        new Setting(this.contentEl).addButton(b => b.setButtonText(t('取消')).onClick(() => this.close())).addButton(b => b.setButtonText(t('插入')).setCta().onClick(() => {
            if (kind === 'subfigures' && height && (!/^\d+$/.test(height) || Number(height) < 16 || Number(height) > 1200)) { new Notice(t('高度须为 16–1200 的整数，或留空。')); return; }
            const result = environmentTemplate(kind, this.editor.getValue(), count, columns, height ? Number(height) : undefined);
            let line = this.editor.getCursor('from').line;
            // Keep existing callouts intact by inserting before the enclosing quote block.
            if (/^\s*>/.test(this.editor.getLine(line))) while (line > 0 && /^\s*>/.test(this.editor.getLine(line - 1))) line--;
            const at = { line, ch: 0 }, offset = this.editor.posToOffset(at);
            const prefix = line > 0 && this.editor.getLine(line - 1).trim() ? '\n' : '';
            this.editor.replaceRange(prefix + result.text + '\n\n', at);
            this.editor.setSelection(this.editor.offsetToPos(offset + prefix.length + result.selection.start), this.editor.offsetToPos(offset + prefix.length + result.selection.end));
            this.close(); this.editor.focus();
        }));
    }
}
export { ProgressModal, ReferencePicker, ReferenceSuggest, BookPicker, EnvironmentModal };
