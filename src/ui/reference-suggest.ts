import { EditorSuggest, setIcon } from 'obsidian';
import type { Editor, EditorPosition, EditorSuggestContext, TFile } from 'obsidian';
import Engine from '../indexing/engine';
import type { SourceRecord } from '../indexing/engine';
import type AcademicNotes from '../main';
import { t } from '../i18n';

/** True when the cursor is inside a $$ block; frontmatter, comments and fenced code are masked. */
export function inDisplayMath(editor: Editor, cursor: EditorPosition) {
    const before = editor.getRange({ line: 0, ch: 0 }, cursor);
    return (Engine.maskedSource(before).match(/(?<!\\)\$\$/g) || []).length % 2 === 1;
}

type NavSuggestion = { type: 'folder' | 'file'; path: string; count: number; manual: number; current?: boolean };
export type ReferenceSuggestion = NavSuggestion | { type: 'record'; record: SourceRecord };
interface FileEntry { path: string; source: string; count: number; manual: number }
interface FolderEntry { path: string; count: number; manual: number }
interface ReferenceTree { files: Map<string, FileEntry>; folders: Map<string, FolderEntry>; byFile: Map<string, SourceRecord[]> }
interface Scope { kind: 'folder' | 'file'; path: string; source?: string; filter: string }

const displayPath = (path: string) => path.replace(/\.md$/i, '');
const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/i, '');
// Each row of a multi-line environment carries its own number/tag; never borrow the block's.
const isManual = (r: SourceRecord) => r.rows ? !!(r.id && r.rowTags?.[r.id]) : !!r.manual;
const rank = (r: SourceRecord) => isManual(r) ? 0 : (r.rows ? !!(r.id && r.rowNumbers?.[r.id]) : !!r.number) ? 1 : r.id ? 2 : 3;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const byRecord = (a: SourceRecord, b: SourceRecord) => rank(a) - rank(b) || natural(a.path, b.path) || a.line - b.line;
const navOrder = (a: NavSuggestion, b: NavSuggestion) => a.type === b.type ? natural(a.path, b.path) : a.type === 'folder' ? -1 : 1;
// Path prefixes are limited so a long query still leaves room for matching targets.
const MAX_NAV = 6;

function referenceTree(records: SourceRecord[]): ReferenceTree {
    const byFile = new Map<string, SourceRecord[]>();
    for (const record of records) {
        const list = byFile.get(record.path);
        if (list) list.push(record); else byFile.set(record.path, [record]);
    }
    const files = new Map<string, FileEntry>(), folders = new Map<string, FolderEntry>();
    for (const [source, list] of byFile) {
        const path = displayPath(source), manual = list.filter(isManual).length;
        files.set(path.toLowerCase(), { path, source, count: list.length, manual });
        for (let dir = parentPath(path); dir; dir = parentPath(dir)) {
            const key = dir.toLowerCase(), entry = folders.get(key) ?? { path: dir, count: 0, manual: 0 };
            entry.count += list.length; entry.manual += manual;
            folders.set(key, entry);
        }
    }
    return { files, folders, byFile };
}

/** A query drills down after a path separator, or when it names a folder or file exactly. */
function scopeOf(query: string, tree: ReferenceTree): Scope | null {
    const text = query.trim().replace(/\\/g, '/');
    if (!text) return null;
    if (!text.includes('/')) {
        const key = text.replace(/\.md$/i, '').toLowerCase();
        const file = tree.files.get(key);
        if (file) return { kind: 'file', path: file.path, source: file.source, filter: '' };
        const folder = tree.folders.get(key);
        return folder ? { kind: 'folder', path: folder.path, filter: '' } : null;
    }
    const parts = text.replace(/\/+$/, '').replace(/\.md$/i, '').split('/').filter(Boolean);
    for (let i = parts.length; i > 0; i--) {
        const key = parts.slice(0, i).join('/').toLowerCase(), filter = parts.slice(i).join(' ');
        // A path with a separator always means the folder when a note and folder share a name.
        const folder = tree.folders.get(key);
        if (folder) return { kind: 'folder', path: folder.path, filter };
        const file = tree.files.get(key);
        if (file) return { kind: 'file', path: file.path, source: file.source, filter };
    }
    return null;
}

function children(tree: ReferenceTree, parent: string, filter: string): NavSuggestion[] {
    const key = parent.toLowerCase(), query = filter.trim().toLowerCase();
    const match = (path: string) => !query || baseName(path).toLowerCase().includes(query);
    const items: NavSuggestion[] = [];
    for (const entry of tree.folders.values())
        if (parentPath(entry.path).toLowerCase() === key && match(entry.path)) items.push({ type: 'folder', ...entry });
    for (const entry of tree.files.values())
        if (parentPath(entry.path).toLowerCase() === key && match(entry.path)) items.push({ type: 'file', ...entry });
    return items.sort(navOrder);
}

class ReferenceSuggest extends EditorSuggest<ReferenceSuggestion> {
    plugin: AcademicNotes;
    kind = '';
    math = false;
    private queryStart: EditorPosition = { line: 0, ch: 0 };
    private queryEnd: EditorPosition = { line: 0, ch: 0 };
    /** Original query text before the first drill, restored when the popup is dismissed. */
    private drilled: { editor: Editor; start: EditorPosition; text: string; path: string } | null = null;
    private committed = false;
    /** File whose targets are listed; its path is redundant in every row. */
    private scopedFile: string | null = null;
    constructor(plugin: AcademicNotes) {
        super(plugin.app); this.plugin = plugin; this.limit = 30;
        this.setInstructions([{ command: '↵', purpose: t('进入文件夹、文件或插入引用') }, { command: 'esc', purpose: t('取消') }]);
    }
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null) {
        if (!file) return null;
        const before = editor.getLine(cursor.line).slice(0, cursor.ch);
        const m = before.match(/\\(eqref|tref|ref)(?:[ \t]*\{?[ \t]*([^\n}]*))$/);
        if (!m) return null;
        // Editing inside an existing \eqref{...}: include its closing brace so the
        // selected suggestion replaces the whole command instead of leaving "}}".
        const closing = m[0].includes('{') && editor.getLine(cursor.line).charAt(cursor.ch) === '}';
        const start = { line: cursor.line, ch: cursor.ch - m[0].length }, end = closing ? { line: cursor.line, ch: cursor.ch + 1 } : cursor;
        if (!this.context || this.context.start.line !== start.line || this.context.start.ch !== start.ch) { this.drilled = null; this.committed = false; }
        this.kind = m[1];
        this.math = inDisplayMath(editor, cursor);
        this.queryStart = { line: cursor.line, ch: cursor.ch - (m[2] || '').length };
        this.queryEnd = { line: cursor.line, ch: cursor.ch };
        return { start, end, query: (m[2] || '').trim() };
    }
    private records() {
        // \eqref and \tref are filtered shortcuts; \ref remains the general entry point.
        return this.plugin.targets(false).filter(r => this.kind === 'eqref' ? r.kind === 'equation' : this.kind === 'tref' ? r.kind === 'theorem' : true);
    }
    private haystack(r: SourceRecord) {
        return [Engine.refText(r, this.plugin.settings, r.id || undefined), r.path, r.title, r.tex, r.id].filter(Boolean).join(' ').toLowerCase();
    }
    private matchRecords(records: SourceRecord[], filter: string) {
        const query = filter.trim().toLowerCase();
        const matches = query ? records.filter(r => this.haystack(r).includes(query)) : records.slice();
        // A typed label segment must win over rows that merely share the equation's TeX.
        const quality = (r: SourceRecord) => {
            if (!query) return 0;
            const id = r.id?.toLowerCase() || '';
            return id === query || id.endsWith(':' + query) || id.endsWith('-' + query) ? 0 : id.includes(query) ? 1 : 2;
        };
        return matches.sort((a, b) => (query ? quality(a) - quality(b) : 0) || byRecord(a, b));
    }
    getSuggestions(ctx: EditorSuggestContext): ReferenceSuggestion[] {
        const records = this.records(), tree = referenceTree(records), scope = scopeOf(ctx.query, tree);
        this.scopedFile = scope?.kind === 'file' ? scope.source! : null;
        if (scope?.kind === 'file') return this.matchRecords(tree.byFile.get(scope.source!) ?? [], scope.filter).map(record => ({ type: 'record', record }));
        if (scope?.kind === 'folder') return children(tree, scope.path, scope.filter);
        const query = ctx.query.trim().toLowerCase();
        if (!query) {
            const items = children(tree, '', ''), path = displayPath(ctx.file.path), entry = tree.files.get(path.toLowerCase());
            if (!entry) return items;
            // Same-file references dominate in practice, so the first row jumps straight there.
            return [{ type: 'file', ...entry, current: true }, ...items.filter(item => !(item.type === 'file' && item.path === entry.path))];
        }
        const nav: NavSuggestion[] = [];
        for (const entry of tree.folders.values()) if (entry.path.toLowerCase().includes(query)) nav.push({ type: 'folder', ...entry });
        for (const entry of tree.files.values()) if (entry.path.toLowerCase().includes(query)) nav.push({ type: 'file', ...entry });
        nav.sort(navOrder);
        const shown = nav.slice(0, MAX_NAV);
        return [...shown, ...this.matchRecords(records, query).slice(0, Math.max(0, this.limit - shown.length)).map(record => ({ type: 'record' as const, record }))];
    }
    renderSuggestion(item: ReferenceSuggestion, el: HTMLElement) {
        if (item.type === 'record') {
            const r = item.record, title = el.createDiv({ cls: 'an-suggest-title' });
            title.createSpan({ text: Engine.refText(r, this.plugin.settings, r.id || undefined) || Engine.labelName(r.key, this.plugin.settings) });
            if (isManual(r)) title.createSpan({ cls: 'an-suggest-badge', text: t('手动') });
            const row = r.rows?.find(row => !!r.id && row.labels.includes(r.id));
            const snippet = (r.title || (row ? r.tex?.slice(row.from, row.to) : r.tex) || '').replace(/\s+/g, ' ').trim().slice(0, 110);
            const details = [snippet, r.id ? '^' + r.id : t('添加标签并引用'), this.scopedFile === r.path ? '' : r.path];
            el.createDiv({ cls: 'an-suggest-detail', text: details.filter(Boolean).join(' · ') });
            return;
        }
        el.addClass('an-suggest-nav');
        if (item.current) el.addClass('an-suggest-current');
        const title = el.createDiv({ cls: 'an-suggest-title' });
        setIcon(title.createSpan({ cls: 'an-suggest-icon' }), item.type === 'folder' ? 'folder' : 'file-text');
        title.createSpan({ text: item.current ? t('本文件') : item.type === 'folder' ? baseName(item.path) + '/' : baseName(item.path) });
        const details = [item.current ? item.path : parentPath(item.path), t('{0} 个引用', item.count), item.manual ? t('{0} 个手动编号', item.manual) : ''];
        el.createDiv({ cls: 'an-suggest-detail', text: details.filter(Boolean).join(' · ') });
    }
    selectSuggestion(item: ReferenceSuggestion) {
        const ctx = this.context;
        if (!ctx?.file) return;
        if (item.type !== 'record') {
            const text = item.path + '/', from = this.queryStart, to = this.queryEnd;
            if (!this.drilled) this.drilled = { editor: ctx.editor, start: { ...from }, text: ctx.editor.getRange(from, to), path: text };
            else this.drilled.path = text;
            ctx.editor.replaceRange(text, from, to);
            this.queryEnd = { line: from.line, ch: from.ch + text.length };
            ctx.editor.setCursor(this.queryEnd);
            return;
        }
        const query = ctx.query.trim().replace(/\\/g, '/');
        const typed = Engine.labelTarget(query.slice(query.lastIndexOf('/') + 1))?.block || '';
        // Only a typed row label needs forwarding; the record's own ID is already used otherwise.
        const label = typed && item.record.ids.includes(typed) ? typed : undefined;
        this.committed = true; this.drilled = null;
        this.close();
        // The typed command selects the list; the target decides the LaTeX command.
        const command = item.record.kind === 'equation' ? 'eqref' : 'ref';
        void this.plugin.insertReference(ctx.editor, ctx.file, item.record, ctx.start, ctx.end, this.math ? command : undefined, label).catch(e => this.plugin.fail(t('插入引用'), e));
    }
    close() {
        const drilled = this.drilled;
        this.drilled = null;
        if (drilled && !this.committed) this.restore(drilled);
        this.committed = false;
        super.close();
    }
    /** Drop a path prefix that only existed to browse; a drill must not leave a broken \eqref{p/f/. */
    private restore({ editor, start, text, path }: { editor: Editor; start: EditorPosition; text: string; path: string }) {
        const end = { line: start.line, ch: start.ch + path.length };
        if (editor.getRange(start, end) !== path) return;
        editor.replaceRange(text, start, end);
    }
}
export { ReferenceSuggest };
