import { Modal, Platform, renderMath, finishRenderMath } from 'obsidian';
import type AcademicNotes from '../main';
import Engine, { type SourceRecord } from '../indexing/engine';
import { titleInk } from '../rendering/custom-appearance';
import { t } from '../i18n';
import { RenameReferenceModal } from './rename-reference';
export interface PreviewTarget { record: SourceRecord; label: string; /** Link has an href Obsidian can preview natively. */ native: boolean }
export interface NativePreviewInteraction { requiredModifier: boolean; modifier: boolean }
type PagePreviewHost = { enabled?: boolean; instance?: { options?: Record<string, boolean> } };
/** The internal wrapper shape is stable enough to read enabled/options, but must stay optional. */
function pagePreviewHost(plugin: AcademicNotes): PagePreviewHost | null | undefined {
    try {
        const internal = (plugin.app as unknown as { internalPlugins?: { getPluginById?: (id: string) => PagePreviewHost | null } } | undefined)?.internalPlugins;
        // Very old hosts do not expose the internal-plugin registry; assume the
        // core preview still works there and let Obsidian decide.
        if (!internal || typeof internal.getPluginById !== 'function') return undefined;
        return internal.getPluginById('page-preview');
    }
    catch { return undefined; }
}
/** Page preview is a core plugin and can be disabled or absent; keep the plugin card as fallback. */
export function nativePreviewAvailable(plugin: AcademicNotes) {
    const host = pagePreviewHost(plugin);
    return host === undefined ? true : host ? host.enabled !== false : false;
}
/** Whether the current hover source needs Ctrl/Cmd before Page preview opens. */
export function nativePreviewRequiresModifier(plugin: AcademicNotes, anchor: HTMLElement) {
    const editing = !!anchor.closest?.('.cm-editor'), source = editing ? 'editor' : 'preview';
    const host = pagePreviewHost(plugin), option = host?.instance?.options?.[source];
    if (typeof option === 'boolean') return option;
    try {
        const sources = (plugin.app as unknown as { workspace?: { hoverLinkSources?: Record<string, { defaultMod?: boolean }> } }).workspace?.hoverLinkSources;
        const fallback = sources?.[source]?.defaultMod;
        if (typeof fallback === 'boolean') return fallback;
    }
    catch { /* Fall back to Obsidian's documented source defaults. */ }
    // Editing view requires Ctrl/Cmd; Reading view normally previews on plain hover.
    return editing;
}
/** Top-level theorem-family and media blocks render from source in Obsidian's Page preview. */
export function prefersNativePreview(target: PreviewTarget, nativeAvailable = true, interaction?: NativePreviewInteraction) {
    const { record } = target;
    // A LaTeX \eqref anchor deliberately has no href and is only rendered by
    // the plugin; letting it fall through to native Page preview would show nothing.
    const modifierReady = !interaction || !interaction.requiredModifier || interaction.modifier;
    return nativeAvailable && modifierReady && target.native && (!!record.diagram || (record.kind === 'theorem' && record.depth === 1) || ['figure', 'subfigure', 'table', 'algorithm'].includes(record.kind));
}
export function previewTarget(plugin: AcademicNotes, anchor: HTMLElement): PreviewTarget | null {
    const label=anchor.dataset.anEqref, path=anchor.dataset.anSource || anchor.closest<HTMLElement>('[data-an-path]')?.dataset.anPath;
    if(!path || !plugin.graph) return null;
    const raw=label || anchor.dataset.anTarget || '', target=label ? Engine.labelTarget(raw) : Engine.splitTarget(raw);
    const record=label ? plugin.graph.resolveLabel(raw,path) : plugin.graph.resolve(raw,path);
    return record && target ? {record,label:target.block,native:!label && !!anchor.getAttribute('href') && /^[A-Za-z0-9-]+$/.test(target.block)} : null;
}
/**
 * Nested callouts cannot use native Page preview: its block slice keeps every
 * `>` prefix, so a depth-2 lemma renders as an extra blockquote with vertical
 * bars. The plugin card recreates the callout frame from the indexed record
 * instead, using the same callout classes and accent variables as the page.
 */
function referenceCallout(root: HTMLElement, record: SourceRecord, title: string) {
    const box=root.createDiv({cls:'callout an-reference-callout',attr:{'data-callout':record.key}});
    if(record.environment) {
        box.addClass('an-custom-environment');
        box.setAttribute('data-an-style',record.environment.style);
        for(const part of ['color','ink','symbol','motif-color','motif-display'])
            box.style.setProperty(`--an-custom-palette-${part}`,`var(--an-${part}-${record.key})`);
        for(const mode of ['light','dark'] as const) {
            const color=record.environment[mode];
            if(color) {
                box.style.setProperty(`--an-custom-color-${mode}`,color);
                box.style.setProperty(`--an-custom-ink-${mode}`,titleInk(color));
            }
        }
    }
    if(record.key==='proof' && record.proofOwnLine)box.addClass('an-proof-own-line');
    box.createDiv({cls:'callout-title'}).createDiv({cls:'callout-title-inner',text:title});
    return box.createDiv({cls:'callout-content an-reference-excerpt'});
}
export function renderReferencePreview(plugin: AcademicNotes, root: HTMLElement, target: PreviewTarget, close:()=>void) {
    const {record,label}=target, graph=plugin.graph!;
    root.addClass('an-reference-preview');
    const title=Engine.refText(record,plugin.settings,label) || Engine.labelName(record.key,plugin.settings);
    if(record.kind!=='theorem')root.createEl('h3',{text:title});
    root.createEl('p',{cls:'an-reference-location',text:`${record.path}:${record.line+1} · ${label}`});
    const body=record.kind==='theorem' ? referenceCallout(root,record,title) : root.createDiv({cls:'an-reference-excerpt'});
    const prose=(value:string)=>value.replace(/<[^>]*>/g,'').replace(/[*_`]/g,'');
    const math=(tex:string,display:boolean)=>{try{body.append(renderMath(tex,display));}catch{body.createSpan({text:tex});}};
    if(record.kind==='equation' && (record.tex?.length || 0)>8000)body.createEl('p',{text:t('公式较长，请打开笔记查看。')});
    else if(record.kind==='equation') {
        try { math(Engine.previewTex(record,label,plugin.settings.referencePreviewRowOnly,key=>graph.resolveLabel(key,record.path)),true); }
        catch(error) { plugin.recordError(t('引用内容预览'),error); body.createEl('p',{text:t('公式较长，请打开笔记查看。')}); }
    }
    else if(record.diagram || record.kind==='figure' || record.kind==='subfigure') body.createEl('p',{text:record.title || t('图表内容请打开笔记查看。')});
    else {
        const note=graph.notes.get(record.path);
        // Nested callouts are shown flat in the excerpt; strip their [!type]
        // marker (and a title-line block ID) instead of printing raw source.
        const text=(note?.lines.slice(record.line+1,Math.min(record.endLine+1,record.line+14))||[])
            .map(line=>Engine.quote(line).body.replace(/\r$/,''))
            .map(line=>line.replace(/^\[![A-Za-z0-9_-]+(?:\|[^\]]*)?\][+-]?[ \t]*/,''))
            .filter(line=>!/^\^[A-Za-z0-9-]+\s*$/.test(line.trim()))
            .map(line=>line.replace(/[ \t]\^[A-Za-z0-9-]+[ \t]*$/,''))
            .join('\n');
        const excerpt=(text || (record.kind==='theorem' ? '' : record.title) || '').slice(0,1800);
        let at=0;
        for(const span of Engine.mathSpans(excerpt)) {
            body.createSpan({text:prose(excerpt.slice(at,span.from))});
            math(Engine.referenceTex(excerpt.slice(span.contentFrom,span.contentTo),key=>graph.resolveLabel(key,record.path)),span.display);at=span.to;
        }
        body.createSpan({text:prose(excerpt.slice(at))});
    }
    const actions=root.createDiv({cls:'an-reference-actions'});
    const button=(text:string,run:()=>void)=>actions.createEl('button',{text}).addEventListener('click',run);
    button(t('打开目标'),()=>{close();void plugin.openRecord(record).catch(e=>plugin.fail(t('打开块引用'),e));});
    button(t('新标签页打开'),()=>{close();void plugin.openRecord(record,true).catch(e=>plugin.fail(t('打开块引用'),e));});
    button(t('重命名标签'),()=>{close();new RenameReferenceModal(plugin,record.path,label).open();});
    button(t('关闭预览'),close);
    const aliases=record.rowGroups?.find(group=>group.includes(label)) || record.ids;
    const incoming=[...graph.notes.values()].flatMap(note=>note.refs.filter(ref=>ref.target===record && aliases.includes(ref.block)).map(ref=>({note,ref})));
    const list=root.createEl('details');list.createEl('summary',{text:t('被引用 {0} 次',incoming.length)});
    for(const {note,ref} of incoming.slice(0,50)) {
        const link=list.createEl('button',{text:`${note.path}:${ref.line+1}`,cls:'an-reference-incoming'});
        link.addEventListener('click',()=>{close();void plugin.openRecord({...record,path:note.path,line:ref.line}).catch(e=>plugin.fail(t('打开块引用'),e));});
    }
    if(incoming.length>50)list.createEl('p',{text:t('仅显示前 50 处引用。')});
    void finishRenderMath().catch(e=>plugin.recordError(t('引用内容预览'),e));
}
/** Hover never changes focus or editor content; touch uses Obsidian's native modal. */
export class ReferencePreviews {
    private card?: HTMLElement;
    private anchor?: HTMLElement;
    private modal?: Modal;
    private timer?: number;
    private touch=false;
    private restoringFocus=false;
    constructor(private plugin: AcademicNotes, private doc: Document = document) {
        plugin.registerDomEvent(doc,'pointerdown',event=>{this.touch=event.pointerType==='touch';if(!this.card?.contains(event.target as Node) && !this.anchor?.contains(event.target as Node))this.hide();},true);
        // Obsidian's Page preview resolves a block through its own metadata cache,
        // which cannot represent a lemma inside a theorem or strip LaTeX labels
        // from a block embed. When this plugin owns the hover card, keep the
        // native popover out of the way so there is one indexed preview.
        plugin.registerDomEvent(doc,'mouseover',event=>{
            if(!plugin.settings.referencePreview)return;
            const anchor=this.find(event.target as Element | null);
            if(!anchor || anchor.closest('.an-reference-popover'))return;
            const target=previewTarget(plugin,anchor), interaction={requiredModifier:nativePreviewRequiresModifier(plugin,anchor),modifier:event.ctrlKey||event.metaKey};
            if(!target || prefersNativePreview(target,nativePreviewAvailable(plugin),interaction))return;
            event.stopPropagation();
        },true);
        plugin.registerDomEvent(doc,'pointerover',event=>{if(event.pointerType==='touch')return;this.enter(event.target as Element | null,false,event.ctrlKey||event.metaKey);});
        plugin.registerDomEvent(doc,'focusin',event=>this.enter(event.target as Element | null,true));
        plugin.registerDomEvent(doc,'pointerout',event=>this.leave(event.relatedTarget as Node | null));
        plugin.registerDomEvent(doc,'focusout',event=>this.leave(event.relatedTarget as Node | null));
        plugin.registerDomEvent(doc,'click',event=>{
            const anchor=this.find(event.target as Element | null);if(!anchor)return;
            if(!(Platform.isMobile || this.touch) || event.ctrlKey || event.metaKey || event.button!==0 || !plugin.settings.referencePreview){this.hide();return;}
            const target=previewTarget(plugin,anchor);if(!target)return;
            // Mobile still uses the plugin modal for every target: the setting
            // promises "tap to preview, then choose", and native Page preview is
            // not a tap-to-preview affordance on touch devices.
            event.preventDefault();event.stopImmediatePropagation();this.hide();
            const modal=new Modal(plugin.app);this.modal=modal;
            modal.titleEl.setText(t('引用内容预览'));
            try { renderReferencePreview(plugin,modal.contentEl,target,()=>modal.close()); }
            catch(error) { plugin.recordError(t('引用内容预览'),error); modal.close(); return; }
            modal.onClose=()=>{if(this.modal===modal)this.modal=undefined;};modal.open();
        },true);
        plugin.registerDomEvent(doc,'keydown',event=>{
            if(event.key==='Escape'){this.hide(true);return;}
            if(event.key==='Enter'){if(this.find(event.target as Element | null))this.hide();return;}
            // Pressing Mod while a pointer preview is open hands the hover to
            // native Page preview; otherwise both popovers would be visible.
            if(!this.card || !this.anchor || (!event.ctrlKey && !event.metaKey))return;
            const target=previewTarget(plugin,this.anchor);
            if(target && prefersNativePreview(target,nativePreviewAvailable(plugin),{requiredModifier:nativePreviewRequiresModifier(plugin,this.anchor),modifier:true}))this.hide();
        },true);
        plugin.register(()=>this.destroy());
    }
    private find(node: Element | null) { return node?.closest?.<HTMLElement>('a[data-an-target],a[data-an-eqref]') || null; }
    private enter(node: Element | null, focused=false, modifier=false) {
        if(this.restoringFocus || !this.plugin.settings.referencePreview || node?.closest('.an-reference-preview'))return;
        const anchor=this.find(node);if(!anchor || anchor===this.anchor && this.card)return;
        this.clear();this.timer=this.doc.defaultView!.setTimeout(()=>{if(anchor.isConnected)this.show(anchor,focused,modifier);},250);
    }
    private leave(next: Node | null) {
        if(next && (this.anchor?.contains(next)||this.card?.contains(next))) {this.clear();return;}
        this.clear();this.timer=this.doc.defaultView!.setTimeout(()=>this.hide(),180);
    }
    private clear() {if(this.timer!==undefined)this.doc.defaultView!.clearTimeout(this.timer);this.timer=undefined;}
    show(anchor: HTMLElement, focused=false, modifier=false) {
        const target=previewTarget(this.plugin,anchor);
        // Page preview is a pointer affordance; keyboard focus still gets the
        // plugin card so focus-only users keep the documented preview. In an
        // editor Page preview waits for Ctrl/Cmd, so plain hover keeps the card.
        if(!target || !focused && prefersNativePreview(target,nativePreviewAvailable(this.plugin),{requiredModifier:nativePreviewRequiresModifier(this.plugin,anchor),modifier})){this.hide();return;}
        this.hide();this.anchor=anchor;
        const card=this.doc.body.createDiv({cls:'an-reference-popover',attr:{role:'dialog','aria-label':t('引用内容预览')}});this.card=card;
        try { renderReferencePreview(this.plugin,card,target,()=>this.hide(true)); }
        catch(error) { this.plugin.recordError(t('引用内容预览'),error); this.hide(); return; }
        const bounds=anchor.getBoundingClientRect(),viewport=this.doc.documentElement;
        card.style.left=Math.max(8,Math.min(bounds.left,viewport.clientWidth-card.offsetWidth-8))+'px';
        card.style.top=Math.max(8,Math.min(bounds.bottom+8,viewport.clientHeight-card.offsetHeight-8))+'px';
    }
    hide(restoreFocus=false) {this.clear();const anchor=this.anchor;this.card?.remove();this.card=undefined;this.anchor=undefined;if(restoreFocus){this.restoringFocus=true;anchor?.focus({preventScroll:true});this.restoringFocus=false;}}
    destroy(){this.hide();this.modal?.close();this.modal=undefined;}
}
