import { EditorSuggest, SuggestModal, setIcon } from 'obsidian';
import type { Editor, EditorPosition, EditorSuggestContext, TFile } from 'obsidian';
import Engine from '../indexing/engine';
import type { SourceRecord } from '../indexing/engine';
import type AcademicNotes from '../main';
import { noteEditor } from '../workspace/notes';
import { t } from '../i18n';

/** Share the inline/display math scanner with rendering, including unfinished input. */
export function inMath(editor: Editor, cursor: EditorPosition) {
    const before = editor.getRange({ line: 0, ch: 0 }, cursor);
    return Engine.mathSpans(before, true).some(span => !span.closed && span.contentFrom <= before.length);
}

export type ReferenceScope = { type: 'folder' | 'file'; path: string };
type NavSuggestion = ReferenceScope & { count: number; manual: number; current?: boolean };
export type ReferenceSuggestion = NavSuggestion | { type: 'record'; record: SourceRecord };
const parentPath = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const isManual = (r: SourceRecord) => r.rows ? !!(r.id && r.rowTags?.[r.id]) : !!r.manual;
const natural = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const navOrder = (a: NavSuggestion, b: NavSuggestion) => a.type === b.type ? natural(a.path, b.path) : a.type === 'folder' ? -1 : 1;

function referenceTree(records: SourceRecord[]) {
    const files = new Map<string, NavSuggestion>(), folders = new Map<string, NavSuggestion>();
    for (const r of records) {
        const file = files.get(r.path) ?? { type: 'file', path: r.path, count: 0, manual: 0 };
        file.count++; file.manual += Number(isManual(r)); files.set(r.path, file);
        for (let dir = parentPath(r.path); dir; dir = parentPath(dir)) {
            const folder = folders.get(dir) ?? { type: 'folder', path: dir, count: 0, manual: 0 };
            folder.count++; folder.manual += Number(isManual(r)); folders.set(dir, folder);
        }
    }
    return { files, folders };
}

export function referenceSuggestions(plugin: AcademicNotes, kind: string, sourcePath: string, query: string, scope: ReferenceScope = { type: 'folder', path: '' }, limit = 30): ReferenceSuggestion[] {
    const all = plugin.targets(false).filter(r => kind === 'eqref' ? r.kind === 'equation' : kind === 'tref' ? r.kind === 'theorem' : true);
    const records = all.filter(r => scope.type === 'file' ? r.path === scope.path : !scope.path || r.path.startsWith(scope.path + '/'));
    const q = query.trim().toLowerCase(), tree = referenceTree(records);
    const nav = scope.type === 'file' ? [] : [...tree.folders.values(), ...tree.files.values()]
        .filter(item => q ? item.path.toLowerCase().includes(q) : parentPath(item.path) === scope.path).sort(navOrder);
    if (!q && scope.type === 'folder') {
        const current = tree.files.get(sourcePath);
        return (current ? [{ ...current, current: true }, ...nav.filter(item => item.type !== 'file' || item.path !== sourcePath)] : nav).slice(0, limit);
    }
    const matches = records.filter(r => !q || [Engine.refText(r, plugin.settings, r.id || undefined), r.path, r.title, r.tex, r.id].filter(Boolean).join(' ').toLowerCase().includes(q));
    const quality = (r: SourceRecord) => {
        if (!q) return 0;
        const id = r.id?.toLowerCase() || '';
        return id === q || id.endsWith(':' + q) || id.endsWith('-' + q) ? 0 : id.includes(q) ? 1 : 2;
    };
    matches.sort((a,b) => quality(a)-quality(b) || (plugin.settings.referenceManualFirst ? Number(isManual(b))-Number(isManual(a)) : 0) || natural(a.path,b.path) || a.line-b.line);
    const shown = nav.slice(0, 6);
    return [...shown, ...matches.slice(0, Math.max(0, limit-shown.length)).map(record => ({ type: 'record' as const, record }))];
}

function renderReference(item: ReferenceSuggestion, el: HTMLElement, plugin: AcademicNotes) {
    const title = el.createDiv({ cls: 'an-suggest-title' });
    if (item.type === 'record') {
        const r = item.record;
        title.createSpan({ text: Engine.refText(r, plugin.settings, r.id || undefined) || Engine.labelName(r.key, plugin.settings) });
        if (isManual(r)) title.createSpan({ cls: 'an-suggest-badge', text: t('手动') });
        const row = r.rows?.find(row => !!r.id && row.labels.includes(r.id));
        const snippet = (r.title || (row ? r.tex?.slice(row.from,row.to) : r.tex) || '').replace(/\s+/g,' ').trim().slice(0,110);
        el.createDiv({ cls: 'an-suggest-detail', text: [snippet, r.id ? '^'+r.id : t('添加标签并引用'), r.path].filter(Boolean).join(' · ') });
    } else {
        el.addClass('an-suggest-nav');
        if (item.current) el.addClass('an-suggest-current');
        setIcon(title.createSpan({ cls: 'an-suggest-icon' }), item.type === 'folder' ? 'folder' : 'file-text');
        title.createSpan({ text: item.current ? t('本文件') : baseName(item.path)+(item.type === 'folder' ? '/' : '') });
        el.createDiv({ cls: 'an-suggest-detail', text: [item.path, t('{0} 个引用',item.count), item.manual ? t('{0} 个手动编号',item.manual) : ''].filter(Boolean).join(' · ') });
    }
}

function insert(plugin: AcademicNotes, ctx: EditorSuggestContext, item: SourceRecord, math: boolean, query: string) {
    const typed = Engine.labelTarget(query)?.block || '';
    const label = item.ids.includes(typed) ? typed : undefined;
    return plugin.insertReference(ctx.editor,ctx.file,item,ctx.start,ctx.end,math ? item.kind === 'equation' ? 'eqref' : 'ref' : undefined,label);
}

/** Use the host's public suggestion/input APIs; browsing never edits the note. */
export class ReferenceBrowser extends SuggestModal<ReferenceSuggestion> {
    private original: string;
    private locationEl?: HTMLElement;
    private backButton?: HTMLButtonElement;
    private committing = false;
    constructor(private plugin: AcademicNotes, private origin: EditorSuggestContext, private kind: string, private math: boolean, public location: ReferenceScope) {
        super(plugin.app);
        this.original = origin.editor.getValue(); this.limit = 100;
        this.setPlaceholder(t('搜索当前范围内的文件或引用'));
        this.setInstructions([{command:'↵',purpose:t('进入文件夹、文件或插入引用')},{command:'esc',purpose:t('取消')}]);
    }
    async onOpen() {
        await super.onOpen();
        this.modalEl.addClass('an-reference-browser');
        const navigation = this.modalEl.createDiv({cls:'an-reference-navigation'});
        this.inputEl.before(navigation);
        this.backButton = navigation.createEl('button',{text:t('返回上级')});
        this.backButton.addEventListener('click',()=>this.navigate({type:'folder',path:parentPath(this.location.path)}));
        navigation.createEl('button',{text:t('全部笔记')}).addEventListener('click',()=>this.navigate({type:'folder',path:''}));
        this.locationEl = navigation.createSpan({attr:{'aria-live':'polite'}});
        this.navigate(this.location);
    }
    navigate(location: ReferenceScope) {
        this.location = location;
        if (this.locationEl) this.locationEl.textContent = location.path || t('全部笔记');
        if (this.backButton) this.backButton.disabled = !location.path;
        this.inputEl.value = '';
        this.inputEl.dispatchEvent(new this.inputEl.ownerDocument.defaultView!.Event('input', {bubbles:true}));
        this.inputEl.focus();
    }
    getSuggestions(query: string) { return referenceSuggestions(this.plugin,this.kind,this.origin.file.path,query,this.location,this.limit); }
    renderSuggestion(item: ReferenceSuggestion, el: HTMLElement) { renderReference(item,el,this.plugin); }
    selectSuggestion(item: ReferenceSuggestion) {
        if (item.type !== 'record') { this.navigate(item); return; }
        this.onChooseSuggestion(item);
    }
    onChooseSuggestion(item: ReferenceSuggestion) {
        if (item.type !== 'record' || this.committing) return;
        this.committing = true;
        const query = this.inputEl.value;
        this.close();
        try {
            if (this.origin.editor.getValue() !== this.original || noteEditor(this.plugin,this.origin.file) !== this.origin.editor) throw new Error(t('当前笔记已变化，请重新选择引用。'));
            void insert(this.plugin,this.origin,item.record,this.math,query).catch(e=>this.plugin.fail(t('插入引用'),e));
        } catch(e) { this.plugin.fail(t('插入引用'),e); }
    }
}

export class ReferenceSuggest extends EditorSuggest<ReferenceSuggestion> {
    kind = '';
    math = false;
    private browser?: ReferenceBrowser;
    constructor(private plugin: AcademicNotes) {
        super(plugin.app); this.limit = 30;
        this.setInstructions([{command:'↵',purpose:t('进入文件夹、文件或插入引用')},{command:'esc',purpose:t('取消')}]);
        plugin.register(()=>this.browser?.close());
    }
    onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null) {
        if (!file) return null;
        const before = editor.getLine(cursor.line).slice(0,cursor.ch), m = before.match(/\\(eqref|tref|ref)(?:[ \t]*\{?[ \t]*([^\n}]*))$/);
        if (!m) return null;
        this.kind = m[1]; this.math = inMath(editor,cursor);
        const closing = m[0].includes('{') && editor.getLine(cursor.line).charAt(cursor.ch) === '}';
        return {start:{line:cursor.line,ch:cursor.ch-m[0].length},end:closing ? {line:cursor.line,ch:cursor.ch+1} : cursor,query:(m[2]||'').trim()};
    }
    getSuggestions(ctx: EditorSuggestContext) { return referenceSuggestions(this.plugin,this.kind,ctx.file.path,ctx.query,undefined,this.limit); }
    renderSuggestion(item: ReferenceSuggestion, el: HTMLElement) { renderReference(item,el,this.plugin); }
    selectSuggestion(item: ReferenceSuggestion) {
        const ctx = this.context;
        if (!ctx?.file) return;
        const math = this.math;
        this.close();
        if (item.type !== 'record') {
            this.browser?.close();
            this.browser = new ReferenceBrowser(this.plugin,ctx,this.kind,math,item); this.browser.open();
        } else void insert(this.plugin,ctx,item.record,math,ctx.query).catch(e=>this.plugin.fail(t('插入引用'),e));
    }
}
