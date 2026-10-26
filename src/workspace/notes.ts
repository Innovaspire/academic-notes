import { MarkdownView, type Editor, type TFile, parseYaml, stringifyYaml } from 'obsidian';
import type AcademicNotes from '../main';
import Engine, { type SourceRecord } from '../indexing/engine';
import { t } from '../i18n';

export function noteEditor(plugin: AcademicNotes, file: TFile) {
    const editors = plugin.app.workspace.getLeavesOfType('markdown').map(l => l.view)
        .filter((v): v is MarkdownView => v instanceof MarkdownView && v.file?.path === file.path && v.getMode() === 'source').map(v => v.editor);
    if (editors.some(e => e.getValue() !== editors[0].getValue())) throw new Error(t('同一笔记有不同的未保存内容，请先同步编辑窗口。'));
    return editors[0];
}
export function replaceBuffer(editor: Editor, next: string) {
    const before = editor.getValue(); if (before === next) return;
    let start = 0, end = before.length, nextEnd = next.length;
    while (start < end && start < nextEnd && before[start] === next[start]) start++;
    while (end > start && nextEnd > start && before[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
    editor.replaceRange(next.slice(start, nextEnd), editor.offsetToPos(start), editor.offsetToPos(end));
}
export async function editNote(plugin: AcademicNotes, file: TFile, update: (text: string) => string) {
    const editor = noteEditor(plugin, file);
    if (editor) replaceBuffer(editor, update(editor.getValue()));
    else await plugin.app.vault.process(file, update);
}
export function frontmatter(source: string) {
    const match = source.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    const data: unknown = match ? parseYaml(match[1]) ?? {} : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(t('笔记属性格式无效。'));
    return { match, data: data as Record<string, unknown> };
}
export function saveBookSource(source: string, book: Record<string, unknown>, existing = false) {
    const { match, data } = frontmatter(source);
    if (existing && (!data['phb-book'] || typeof data['phb-book'] !== 'object' || Array.isArray(data['phb-book']) || !Array.isArray((data['phb-book'] as Record<string, unknown>).files))) throw new Error(t('该路径不是合订本清单，请选择新路径。'));
    data['phb-book'] = { ...(data['phb-book'] && typeof data['phb-book'] === 'object' ? data['phb-book'] : {}), ...book };
    return '---\n' + stringifyYaml(data).trimEnd() + '\n---\n' + source.slice(match?.[0].length || 0);
}
export function labelInsertion(source: string, record: SourceRecord, settings: Parameters<typeof Engine.parse>[3] = {}) {
    const note = Engine.parse(record.path, source, {}, settings);
    let id: string;
    do { id = 'an-' + Math.random().toString(36).slice(2, 10); } while (note.anchors?.has(id) || note.blocks.has(id));
    const prefix = record.kind === 'equation' || record.diagram ? Engine.quote(note.lines[record.endLine]).prefix : record.depth > 1 ? '> '.repeat(record.depth - 1) : '';
    return { id, at: note.starts[record.endLine] + note.lines[record.endLine].length, text: '\n' + prefix + '\n' + prefix + '^' + id + '\n' };
}
export function currentRecord(source: string, original: string, record: SourceRecord, settings: Parameters<typeof Engine.parse>[3], cache: Parameters<typeof Engine.parse>[2] = {}) {
    // Obsidian's block cache binds IDs written on callout title lines; a bare parse misses them.
    const note = Engine.parse(record.path, source, cache, settings), text = original.slice(record.from, record.to);
    const matches = note.records.filter(r => r.kind === record.kind && r.key === record.key && source.slice(r.from, r.to) === text);
    const found = source === original ? matches.find(r => r.from === record.from) : matches.length === 1 ? matches[0] : undefined;
    if (!found) throw new Error(t('目标内容已变化或不唯一，请重新选择引用。'));
    if (found.ids.length && !found.ids.some(id => note.blocks.get(id) === found)) throw new Error(t('目标块标签重复'));
    return { ...found, id: found.ids.find(id => note.blocks.get(id) === found) || null };
}
