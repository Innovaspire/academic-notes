import type { CachedMetadata, Pos } from 'obsidian';
import type { ParsedNote, SourceRecord } from './engine';

export interface NativeBlockEntry {
    existed: boolean;
    /** Position Obsidian owned before this plugin touched the block. */
    position?: Pos;
    /** Position written by this plugin; used to detect host-side changes. */
    patched?: Pos;
}

export interface NativeBlockSave {
    cache: CachedMetadata;
    /** The blocks object this save belongs to; Obsidian may replace it in place. */
    blocks?: CachedMetadata['blocks'];
    /** JSON of the cache after our last successful alignment. */
    patched?: string;
    entries: Map<string, NativeBlockEntry>;
}

const copy = (loc: Pos['start']): Pos['start'] => ({ line: loc.line, col: loc.col, offset: loc.offset });
const assign = (target: Pos['start'], loc: Pos['start']) => { target.line = loc.line; target.col = loc.col; target.offset = loc.offset; };
const same = (a: Pos | undefined, b: Pos | undefined) => !!a && !!b
    && a.start.line === b.start.line && a.start.col === b.start.col && a.start.offset === b.start.offset
    && a.end.line === b.end.line && a.end.col === b.end.col && a.end.offset === b.end.offset;

/**
 * The cache position Obsidian uses for a block reference. Always align to whole
 * source lines: an equation that starts after a blockquote prefix is otherwise
 * sliced with the prefix still on its inner lines, which is not valid Markdown.
 */
export function nativeBlockSpan(note: ParsedNote, record: SourceRecord): Pos {
    const line = record.line, endLine = record.endLine;
    return {
        start: { line, col: 0, offset: note.starts[line] },
        end: { line: endLine, col: note.lines[endLine].length, offset: note.starts[endLine] + note.lines[endLine].length }
    };
}

function existingKey(blocks: Record<string, unknown>, id: string) {
    if (Object.hasOwn(blocks, id)) return id;
    const lower = id.toLowerCase();
    return Object.keys(blocks).find(key => key.toLowerCase() === lower);
}

/** Undo one entry, unless the host has replaced our position in the meantime. */
function restoreEntry(blocks: NonNullable<CachedMetadata['blocks']>, id: string, entry: NativeBlockEntry) {
    const key = existingKey(blocks, id), current = key ? blocks[key] : undefined;
    if (!key || !current || !current.position) return false;
    if (entry.patched && !same(current.position, entry.patched)) return false;
    if (!entry.existed) {
        if (current.id === id || (typeof current.id === 'string' && current.id.toLowerCase() === id.toLowerCase())) {
            delete blocks[key];
            return true;
        }
        return false;
    }
    if (!entry.position) return false;
    assign(current.position.start, entry.position.start);
    assign(current.position.end, entry.position.end);
    return true;
}

/**
 * Obsidian's own metadata only attaches a block ID to the outer callout, and it
 * omits IDs on callout title lines and standalone quoted lines entirely. Point
 * its cache at the record that actually owns the ID so the native hover preview
 * and block navigation show the lemma/equation instead of the enclosing theorem.
 */
export function patchNativeBlocks(cache: CachedMetadata, note: ParsedNote, save: NativeBlockSave) {
    if (!cache.blocks && ![...note.blocks.values()].some(Boolean)) {
        save.entries.clear(); save.patched = undefined;
        return false;
    }
    const blocks = cache.blocks ?? (cache.blocks = {});
    if (save.blocks && save.blocks !== blocks) { save.entries.clear(); save.patched = undefined; }
    save.blocks = blocks;
    let changed = false, ids = new Set<string>();
    for (const [id, record] of note.blocks) {
        if (!record || record.line < 0 || record.endLine < record.line || record.endLine >= note.lines.length) continue;
        ids.add(id);
        const key = existingKey(blocks, id), current = key ? blocks[key] : undefined;
        // Some host entries legitimately have no position. There is no source
        // range to align and no original range to restore, so leave them alone
        // instead of inventing a position that unload could not remove.
        if (current && !current.position) { save.entries.delete(id); continue; }
        if (!save.entries.has(id)) {
            save.entries.set(id, current ? { existed: true, position: { start: copy(current.position.start), end: copy(current.position.end) } } : { existed: false });
        }
        const entry = save.entries.get(id)!, span = nativeBlockSpan(note, record);
        // If the host moved or re-created the entry since our last write, treat
        // its current position as the new original instead of restoring stale data.
        if (entry.patched && current && !same(current.position, entry.patched)) {
            entry.existed = true;
            entry.position = { start: copy(current.position.start), end: copy(current.position.end) };
            delete (current as unknown as { anSynthetic?: boolean }).anSynthetic;
        }
        // The host removed an entry we had aligned. If we re-create it now,
        // Obsidian did not own it at unload time, so do not restore a ghost.
        else if (entry.patched && !current) entry.existed = false;
        entry.patched = { start: copy(span.start), end: copy(span.end) };
        if (current) {
            if (current.position.start.line !== span.start.line || current.position.start.col !== span.start.col || current.position.start.offset !== span.start.offset
                || current.position.end.line !== span.end.line || current.position.end.col !== span.end.col || current.position.end.offset !== span.end.offset) {
                assign(current.position.start, span.start);
                assign(current.position.end, span.end);
                changed = true;
            }
        }
        else {
            // defineProperty, not assignment: a label literally named
            // "__proto__" must not mutate the cache object's prototype.
            Object.defineProperty(blocks, id, { value: { id, position: { start: copy(span.start), end: copy(span.end) } }, enumerable: true, configurable: true, writable: true });
            // The parser will bind this ID from source while the marker exists.
            // Marking it keeps Obsidian's stale cache from resurrecting a label
            // that the user already removed from the note.
            (blocks[id] as unknown as { anSynthetic?: boolean }).anSynthetic = true;
            changed = true;
        }
    }
    // A label removed or rebound by an edit must not leave a stale patched
    // position behind while the metadata cache object stays alive.
    for (const id of [...save.entries.keys()]) {
        if (ids.has(id)) continue;
        if (restoreEntry(blocks, id, save.entries.get(id)!)) changed = true;
        save.entries.delete(id);
    }
    return changed;
}

/** Undo our cache edits when the plugin unloads; Obsidian owns the cache again. */
export function restoreNativeBlocks(save: NativeBlockSave) {
    // Restore the map we actually edited. If Obsidian replaced it in the
    // meantime, the replacement is host-owned and must not be clobbered.
    const blocks = save.blocks ?? save.cache.blocks;
    if (!blocks) return false;
    let changed = false;
    for (const [id, entry] of save.entries) if (restoreEntry(blocks, id, entry)) changed = true;
    return changed;
}
