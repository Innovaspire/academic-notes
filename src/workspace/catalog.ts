import Engine, { type NoteGraph } from '../indexing/engine';
import { t } from '../i18n';

export interface CatalogOptions {
    version: 1;
    scope: 'note' | 'folder' | 'vault' | 'book';
    source: string;
    types: string[];
    group: 'type' | 'file';
    unnumbered: boolean;
    folder?: string;
    generatedAt?: string;
}
export const CATALOG_START = '<!-- academic-notes:index:start';
export const CATALOG_END = '<!-- academic-notes:index:end -->';
const region = /^<!-- academic-notes:index:start[ \t]*\r?\n([^]*?)\r?\n-->[^]*?^<!-- academic-notes:index:end -->[ \t]*\r?$/gm;
function catalogMask(source: string) {
    let fence = '';
    return source.split('\n').map(line => {
        const marker = line.match(/^[ \t]*(`{3,}|~{3,})(.*)$/);
        if (!fence && marker) { fence = marker[1]; return ' '.repeat(line.length); }
        if (fence) {
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
            return ' '.repeat(line.length);
        }
        return line;
    }).join('\n');
}
function onlyRegion(source: string) {
    const mask = catalogMask(source), matches = [...mask.matchAll(region)];
    if (matches.length !== 1 || mask.split(CATALOG_START).length !== 2 || mask.split(CATALOG_END).length !== 2)
        throw new Error(t('索引标记缺失或重复；为保护手写内容，请生成新的索引笔记。'));
    matches[0][0] = source.slice(matches[0].index, matches[0].index + matches[0][0].length);
    return matches[0];
}
export function readCatalog(source: string): CatalogOptions | null {
    if (!catalogMask(source).includes(CATALOG_START)) return null;
    const match = onlyRegion(source);
    let data: CatalogOptions;
    try { data = JSON.parse(match[1]) as CatalogOptions; } catch { throw new Error(t('索引配置无效。')); }
    if (data?.version !== 1 || !['note', 'folder', 'vault', 'book'].includes(data.scope) || typeof data.source !== 'string' || data.source.length > 2000 ||
        !['type', 'file'].includes(data.group) || typeof data.unnumbered !== 'boolean' || !Array.isArray(data.types) || data.types.length > 100 ||
        data.types.some(key => typeof key !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(key)) ||
        data.folder !== undefined && (typeof data.folder !== 'string' || data.folder.length > 2000) ||
        data.generatedAt !== undefined && (typeof data.generatedAt !== 'string' || !Number.isFinite(Date.parse(data.generatedAt)))) throw new Error(t('索引配置无效。'));
    return data;
}
const label = (text: string) => text.replace(/[\r\n|[\]<>]/g, ' ').trim();
function link(path: string, fragment: string, text: string) {
    const target = path.replace(/\.md$/i, '') + fragment;
    if (/[[\]|#]/.test(path)) return `[${label(text)}](<${encodeURI(path).replace(/#/g, '%23').replace(/\[/g, '%5B').replace(/\]/g, '%5D')}${fragment ? '#' + encodeURIComponent(fragment.slice(1)) : ''}>)`;
    return `[[${target.replace(/\]/g, '')}|${label(text)}]]`;
}
export function catalogBody(graph: NoteGraph, options: CatalogOptions, paths: Set<string>, destination: string) {
    const groups = new Map<string, string[]>(); let count = 0, approximate = 0;
    for (const path of paths) {
        if (path === destination) continue;
        const note = graph.notes.get(path); if (!note) continue;
        for (const record of note.records) {
            if (!options.types.includes(record.key) || !options.unnumbered && !record.number) continue;
            const id = record.ids.find(id => note.blocks.get(id) === record && (note.anchors?.get(id)?.length || 0) < 2);
            const heading = [...note.headings].reverse().find(h => h.line < record.line);
            const name = `${Engine.labelName(record.key, graph.settings)}${record.number ? ' ' + record.number : ''}`;
            const title = record.title ? ' — ' + label(Engine.plain(record.title)) : '';
            const target = link(path, id ? '#^' + id : heading ? '#' + heading.title.replace(/[|[\]]/g, '') : '', name);
            const context = options.group === 'type' ? ` · ${label(path.replace(/\.md$/i, ''))}` : '';
            const hint = id ? '' : ' · ' + t('无块标签，跳转至章节或笔记');
            const key = options.group === 'type' ? Engine.labelName(record.key, graph.settings) : path.replace(/\.md$/i, '');
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push(`- ${target}${title}${context}${hint}`); count++; if (!id) approximate++;
        }
    }
    const summary = t('共 {0} 项；其中 {1} 项没有唯一块标签，使用章节或笔记链接。', count, approximate);
    const content = [...groups].map(([name, lines]) => `## ${label(name)}\n\n${lines.join('\n')}`).join('\n\n');
    return `${summary}\n\n${content || t('当前范围内没有符合条件的学术环境。')}`;
}
export function renderCatalog(options: CatalogOptions, body: string) {
    const config = JSON.stringify(options).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
    return `${CATALOG_START}\n${config}\n-->\n\n${body}\n\n${CATALOG_END}`;
}
export function updateCatalog(source: string, options: CatalogOptions, body: string) {
    const match = onlyRegion(source), next = renderCatalog(options, body);
    return source.slice(0, match.index) + next + source.slice(match.index + match[0].length);
}
export function catalogContent(source: string) {
    const match = onlyRegion(source);
    return match[0].slice(match[0].indexOf('\n-->') + 4, match[0].lastIndexOf(CATALOG_END)).trim();
}
export function remapCatalog(source: string, oldPath: string, newPath: string) {
    const options = readCatalog(source); if (!options) return source;
    const move = (path: string) => path === oldPath ? newPath : path.startsWith(oldPath + '/') ? newPath + path.slice(oldPath.length) : path;
    if (options.scope === 'folder' && options.folder === undefined) options.folder = options.source.slice(0, options.source.lastIndexOf('/') + 1).replace(/\/$/, '');
    const next = { ...options, source: move(options.source), ...(options.folder === undefined ? {} : { folder: move(options.folder) }) };
    if (next.source === options.source && next.folder === options.folder) return source;
    return updateCatalog(source, next, catalogContent(source));
}
