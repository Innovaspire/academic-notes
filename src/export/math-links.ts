import Engine, { type NoteGraph } from '../indexing/engine';

/** Resolve private MathJax link markers before the document assigns chapter-local IDs. */
export function prepareMathLinks(root: HTMLElement, graph: NoteGraph, path: string) {
    for (const a of root.querySelectorAll<HTMLElement>('a')) {
        const href = a.getAttribute('href') || a.getAttribute('xlink:href') || '';
        if (!href.startsWith('an-eqref:')) continue;
        a.removeAttribute('xlink:href'); a.setAttribute('href', href);
        const label = Engine.decodeLabel(href.slice(9));
        const key = Engine.labelTarget(label), target = graph.resolveLabel(label, path);
        if (target && key) {
            a.dataset.phbLink = target.path + '#^' + key.block;
            a.dataset.phbCanonical = 'true';
            a.classList.add('internal-link');
        } else a.removeAttribute('href');
    }
}
