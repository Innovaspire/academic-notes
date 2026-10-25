export interface MathSpan { from: number; to: number; contentFrom: number; contentTo: number; display: boolean; closed: boolean }
const escaped = (text: string, at: number) => { let n = 0; while (at > 0 && text[--at] === '\\') n++; return n % 2 === 1; };
/** Input is Markdown with code/frontmatter/comments masked but source offsets retained. */
export function scanMath(mask: string, includeUnclosed = false): MathSpan[] {
    const spans: MathSpan[] = [];
    for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== '$' || escaped(mask, i)) continue;
        const display = mask[i + 1] === '$', size = display ? 2 : 1;
        if (!display && (!mask[i + 1] || /\s/.test(mask[i + 1]))) continue;
        let end = -1;
        for (let j = i + size; j < mask.length; j++) {
            if (!display && /[\r\n]/.test(mask[j])) break;
            if (mask[j] === '%' && !escaped(mask, j)) { const next = mask.indexOf('\n', j); if (next < 0) break; j = next - 1; continue; }
            if (mask[j] !== '$' || escaped(mask, j)) continue;
            if (display ? mask[j + 1] === '$' : mask[j + 1] !== '$' && !/\s/.test(mask[j - 1]) && !/\d/.test(mask[j + 1] || '')) { end = j; break; }
        }
        if (end >= 0) { spans.push({from:i, to:end+size, contentFrom:i+size, contentTo:end, display, closed:true}); i = end + size - 1; }
        else if (includeUnclosed && (display || !/[\r\n]/.test(mask.slice(i + size)))) { spans.push({from:i,to:mask.length,contentFrom:i+size,contentTo:mask.length,display,closed:false}); break; }
    }
    return spans;
}
