import Engine, { type NoteGraph, type ParsedNote } from '../indexing/engine';
import { t } from '../i18n';

export type AuditCode = 'duplicate-id' | 'missing-file' | 'ambiguous-file' | 'excluded-file' | 'missing-block' | 'ambiguous-block' | 'outside-book' | 'number-conflict';
export interface AuditIssue { code: AuditCode; path: string; line: number; detail: string; related?: { path: string; line: number } }
export interface AuditOptions {
    paths?: Set<string>;
    book?: boolean;
    resolve?: (name: string, here: string) => string | null;
    externalBlock?: (path: string, id: string) => boolean;
}
export function anchorLines(note: ParsedNote): Map<string, number[]> { return note.anchors || new Map<string, number[]>(); }
export function auditReferences(graph: NoteGraph, options: AuditOptions = {}): AuditIssue[] {
    const issues: AuditIssue[] = [], paths = new Set(graph.notes.keys());
    const anchors = new Map([...graph.notes].map(([path, note]) => [path, anchorLines(note)]));
    const selected = options.paths || paths;
    for (const [path, note] of graph.notes) {
        if (!selected.has(path)) continue;
        for (const [id, lines] of anchors.get(path)!) if (lines.length > 1)
            issues.push({ code: 'duplicate-id', path, line: lines[1], detail: '^' + id, related: { path, line: lines[0] } });
        const numbers = new Map<string, typeof note.records[number]>();
        for (const record of note.records) {
            if (!record.number) continue;
            const bucket = record.kind === 'theorem' ? graph.settings.sharedCounter ? 'theorem' : record.key : record.kind === 'subfigure' ? `subfigure:${record.parent?.from}` : record.kind;
            const key = `${record.scope}|${bucket}|${record.number}`, previous = numbers.get(key);
            if (previous && (previous.manual || record.manual)) issues.push({ code: 'number-conflict', path, line: record.line,
                detail: `${Engine.labelName(record.key, graph.settings)} ${record.number}`, related: { path, line: previous.line } });
            else numbers.set(key, record);
        }
        for (const ref of note.refs) {
            if (/^[a-z][a-z0-9+.-]*:/i.test(ref.file)) continue;
            const targetPath = !ref.file ? path : options.resolve?.(ref.file, path) || Engine.resolvePath(ref.file, path, paths);
            const add = (code: AuditCode) => issues.push({ code, path, line: ref.line, detail: ref.raw });
            if (!targetPath) {
                const name = ref.file.replace(/\.md$/i, '');
                const matching = [...paths].filter(p => p.replace(/\.md$/i, '').split('/').pop() === name);
                add(matching.length > 1 ? 'ambiguous-file' : 'missing-file'); continue;
            }
            const target = graph.notes.get(targetPath);
            if (!target) { add('excluded-file'); continue; }
            const hits = anchors.get(targetPath)?.get(ref.block);
            if ((hits?.length || 0) > 1 || target.blocks.has(ref.block) && target.blocks.get(ref.block) === null) { add('ambiguous-block'); continue; }
            const exists = hits?.length || target.blocks.get(ref.block) || options.externalBlock?.(targetPath, ref.block);
            if (!exists) { add('missing-block'); continue; }
            if (options.book && !selected.has(targetPath)) add('outside-book');
        }
    }
    return issues.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.code.localeCompare(b.code));
}
export function auditLabel(code: AuditCode) {
    switch (code) {
        case 'duplicate-id': return t('重复块标签');
        case 'missing-file': return t('目标笔记不存在');
        case 'ambiguous-file': return t('同名笔记，目标不明确');
        case 'excluded-file': return t('目标未参与索引，无法检查');
        case 'missing-block': return t('目标块标签不存在');
        case 'ambiguous-block': return t('目标块标签重复');
        case 'outside-book': return t('引用目标未选入合订本');
        case 'number-conflict': return t('手动编号与同组编号冲突');
    }
}
