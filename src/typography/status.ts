/** Weak state avoids extra DOM mutations in Obsidian's editor. Contains no note text. */
export type ParagraphStatus = 'optimized' | 'native' | 'editing' | 'selection' | 'excluded' | 'unsupported-style' | 'unsupported-content' | 'limit' | 'narrow' | 'measure-failed' | 'cannot-fit' | 'short' | 'not-run' | 'disabled' | 'paused';
const statuses = new WeakMap<HTMLElement, ParagraphStatus>();
export function setParagraphStatus(node: HTMLElement, reason: ParagraphStatus) { statuses.set(node, reason); }
export function paragraphStatus(node: HTMLElement): ParagraphStatus {
    const selection = node.ownerDocument.getSelection();
    if (selection?.anchorNode && node.contains(selection.anchorNode)) {
        if (!selection.isCollapsed) return 'selection';
        if (node.closest('.cm-editor,[contenteditable="true"]')) return 'editing';
    }
    if (node.dataset.anKp === '1' || node.querySelector('.an-kp-live-line')) return 'optimized';
    const value = statuses.get(node); return value === 'optimized' ? 'native' : value || 'not-run';
}
export function visibleTypographyStatus(root: HTMLElement, options: { reading: boolean; live: boolean; paused: boolean }) {
    const live = [...root.querySelectorAll<HTMLElement>('.markdown-source-view.is-live-preview')].some(node => node.getBoundingClientRect().height > 0);
    const rows = [...root.querySelectorAll<HTMLElement>('p,.cm-line')].filter(node => {
        const box = node.getBoundingClientRect(), win = node.ownerDocument.defaultView!;
        return box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= win.innerHeight;
    }).slice(0, 80);
    return rows.map((node, index) => ({ paragraph: index + 1, status: live && options.paused ? 'paused' : !(live ? options.live : options.reading) ? 'disabled' : paragraphStatus(node) }));
}
