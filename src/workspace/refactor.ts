import { TFile } from 'obsidian';
import { parseDocument, isSeq, isMap, isScalar } from 'yaml';
import Engine, { type NoteGraph, type ParsedNote, type SourceReference } from '../indexing/engine';
import type AcademicNotes from '../main';
import { noteEditor, editNote } from './notes';
import { t } from '../i18n';
export interface NoteChange { path: string; before: string; after: string; count: number }
class RefactorConflict extends Error { constructor(){super(t('笔记在预览后发生变化，请重新预览。'));} }
interface Edit { from: number; to: number; text: string }
const move = (path: string, oldPath: string, newPath: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
function apply(source: string, edits: Edit[]) {
    for (const edit of edits.sort((a,b) => b.from-a.from)) source = source.slice(0,edit.from)+edit.text+source.slice(edit.to);
    return source;
}
function referenceEdit(note: ParsedNote, ref: SourceReference, file: string, block: string): Edit {
    const raw = note.source.slice(ref.from, ref.to);
    let text: string;
    if (ref.syntax === 'latex') text = raw.replace(/\{[\s\S]*\}/, () => '{' + (file ? file.replace(/\.md$/i,'')+'#^' : '') + block + '}');
    else if (ref.syntax === 'wiki') text = raw.replace(/^(!?\[\[)[^|\]]+/, (_, prefix:string) => prefix + file + '#^' + block);
    else text = raw.replace(/(\]\(<?)[^>)]*(>?\))$/, (_, left:string, right:string) => left + encodeURI(file).replace(/#/g,'%23') + '#^' + encodeURIComponent(block) + right);
    return {from:ref.from,to:ref.to,text};
}
/** Update only YAML scalar values, retaining comments, ordering and unrelated properties. */
function remapBook(source: string, here: string, paths: Set<string>, oldPath: string, newPath: string, sourceMoved: boolean) {
    const match = source.match(/^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
    if (!match || !match[2].includes('phb-book')) return source;
    const doc = parseDocument(match[2]);
    if (doc.errors.length) throw new Error(t('笔记属性格式无效。'));
    const files = doc.getIn(['phb-book','files']); if (!isSeq(files)) return source;
    let changed = false;
    for (const entry of files.items) {
        const node = isMap(entry) ? entry.get('path',true) : entry;
        if (!isScalar(node) || typeof node.value !== 'string') continue;
        const raw = node.value, linked = raw.startsWith('[[') && raw.endsWith(']]');
        const body = linked ? raw.slice(2,-2) : raw, [path,...alias] = body.split('|');
        const resolved = Engine.resolvePath(path,here,paths); if (!resolved) continue;
        const next = move(resolved,oldPath,newPath);
        if (next === resolved && !sourceMoved) continue;
        node.value = linked ? '[['+next+(alias.length?'|'+alias.join('|'):'')+']]' : next;
        changed = true;
    }
    return changed ? match[1]+doc.toString().trimEnd()+match[3]+source.slice(match[0].length) : source;
}
export function pathRenamePlan(notes: ParsedNote[], oldPath: string, newPath: string): NoteChange[] {
    const paths = new Set(notes.map(n => move(n.path,newPath,oldPath)));
    if (/\.md$/i.test(oldPath)) paths.add(oldPath);
    return notes.flatMap(note => {
        const here = move(note.path,newPath,oldPath), edits: Edit[] = [];
        for (const ref of note.refs) {
            if (ref.syntax !== 'latex' || !ref.file) continue;
            const resolved = Engine.resolvePath(ref.file,here,paths); if (!resolved) continue;
            const next = move(resolved,oldPath,newPath);
            if (next !== resolved || here !== note.path) edits.push(referenceEdit(note,ref,next,ref.block));
        }
        const linked = apply(note.source,edits);
        const after = remapBook(linked,here,paths,oldPath,newPath,here!==note.path);
        return after === note.source ? [] : [{path:note.path,before:note.source,after,count:edits.length+(after!==linked?1:0)}];
    });
}
export function labelRenamePlan(graph: NoteGraph, path: string, oldLabel: string, newLabel: string): NoteChange[] {
    const note = graph.notes.get(path), record = note?.blocks.get(oldLabel);
    if (!note || !record) throw new Error(t('目标块标签不存在或不唯一。'));
    const native = !!note.anchors?.has(oldLabel);
    if (!(native ? /^[A-Za-z0-9-]+$/ : /^[\p{L}\p{N}][\p{L}\p{N}:._-]*$/u).test(newLabel)) throw new Error(t('标签格式无效；原生块标签只能包含字母、数字和连字符。'));
    if (newLabel === oldLabel) return [];
    if (note.blocks.has(newLabel) || note.anchors?.has(newLabel)) throw new Error(t('新标签已经存在。'));
    const declarations: Edit[] = [];
    for (const line of note.anchors?.get(oldLabel) || []) {
        const at = note.starts[line] + note.lines[line].lastIndexOf('^'+oldLabel);
        declarations.push({from:at+1,to:at+1+oldLabel.length,text:newLabel});
    }
    // Scan the original quoted source so replacements retain exact Markdown positions.
    for (const span of Engine.mathSpans(note.source).filter(s => s.display && s.from >= record.from && s.to <= record.to)) {
        const tex = note.source.slice(span.contentFrom,span.contentTo);
        for (const label of Engine.latexCommands(tex).labels) if (label.name === oldLabel) {
            const at = span.contentFrom + label.index, raw = note.source.slice(at).match(/^\\label\s*\{[^{}]*\}/)?.[0];
            if (raw) declarations.push({from:at,to:at+raw.length,text:'\\label{'+newLabel+'}'});
        }
    }
    if (!declarations.length) throw new Error(t('目标块标签不存在或不唯一。'));
    return [...graph.notes.values()].flatMap(n => {
        const edits = n === note ? [...declarations] : [];
        for (const ref of n.refs) if (ref.targetPath === path && ref.block === oldLabel && ref.target) edits.push(referenceEdit(n,ref,ref.file,newLabel));
        const after = apply(n.source,edits);
        return after === n.source ? [] : [{path:n.path,before:n.source,after,count:edits.length}];
    });
}
export async function refactorGraph(plugin: AcademicNotes) {
    const notes: ParsedNote[] = [];
    for (const file of plugin.app.vault.getMarkdownFiles()) {
        const text = noteEditor(plugin,file)?.getValue() ?? await plugin.app.vault.cachedRead(file);
        notes.push(Engine.parse(file.path,text,{},plugin.settings));
    }
    return Engine.graph(notes,plugin.settings,(name,here)=>plugin.resolver(name,here));
}
/** Compare before writing; roll back our own completed writes if a later file changes. */
export async function applyReferenceChanges(plugin: AcademicNotes, changes: NoteChange[]) {
    const files = new Map<string,TFile>();
    for (const change of changes) {
        const file = plugin.app.vault.getAbstractFileByPath(change.path);
        if (!(file instanceof TFile)) throw new Error(t('目标笔记不存在'));
        const text = noteEditor(plugin,file)?.getValue() ?? await plugin.app.vault.read(file);
        if (text !== change.before) throw new RefactorConflict();
        files.set(change.path,file);
    }
    const applied: NoteChange[] = [];
    try {
        for (const change of changes) {
            if(files.get(change.path)!.path!==change.path)throw new RefactorConflict();
            await editNote(plugin,files.get(change.path)!,text => {
                if (text !== change.before) throw new RefactorConflict();
                return change.after;
            });
            applied.push(change);plugin.dirty.set(change.path,true);
        }
    } catch (error) {
        const remaining: string[] = [];
        for (const change of applied.reverse()) {
            try { await editNote(plugin,files.get(change.path)!,text => { if(text!==change.after)throw new Error('Changed during rollback');return change.before; }); }
            catch { remaining.push(change.path); }
        }
        if(remaining.length) throw new Error(t('部分笔记已变化，无法自动撤销，请检查：{0}',remaining.join(', ')));
        throw error;
    } finally { plugin.scheduleIndex(); }
}
export async function maintainRenamedPaths(plugin: AcademicNotes, oldPath: string, newPath: string) {
    for(let attempt=0;attempt<2;attempt++){
        const graph = await refactorGraph(plugin);
        try{await applyReferenceChanges(plugin,pathRenamePlan([...graph.notes.values()],oldPath,newPath));return;}
        catch(error){if(!(error instanceof RefactorConflict)||attempt)throw error;await new Promise(resolve=>window.setTimeout(resolve,100));}
    }
}
