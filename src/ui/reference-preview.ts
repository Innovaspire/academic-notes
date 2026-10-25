import { Modal, Platform, renderMath, finishRenderMath } from 'obsidian';
import type AcademicNotes from '../main';
import Engine, { type SourceRecord } from '../indexing/engine';
import { t } from '../i18n';
import { RenameReferenceModal } from './rename-reference';
export interface PreviewTarget { record: SourceRecord; label: string }
export function previewTarget(plugin: AcademicNotes, anchor: HTMLElement): PreviewTarget | null {
    const label=anchor.dataset.anEqref, path=anchor.dataset.anSource || anchor.closest<HTMLElement>('[data-an-path]')?.dataset.anPath;
    if(!path || !plugin.graph) return null;
    const raw=label || anchor.dataset.anTarget || '', target=label ? Engine.labelTarget(raw) : Engine.splitTarget(raw);
    const record=label ? plugin.graph.resolveLabel(raw,path) : plugin.graph.resolve(raw,path);
    return record && target ? {record,label:target.block} : null;
}
export function renderReferencePreview(plugin: AcademicNotes, root: HTMLElement, target: PreviewTarget, close:()=>void) {
    const {record,label}=target, graph=plugin.graph!;
    root.addClass('an-reference-preview');
    root.createEl('h3',{text:Engine.refText(record,plugin.settings,label) || Engine.labelName(record.key,plugin.settings)});
    root.createEl('p',{cls:'an-reference-location',text:`${record.path}:${record.line+1} · ${label}`});
    const body=root.createDiv({cls:'an-reference-excerpt'});
    const prose=(value:string)=>value.replace(/<[^>]*>/g,'').replace(/[*_`]/g,'');
    const math=(tex:string,display:boolean)=>{try{body.append(renderMath(tex,display));}catch{body.createSpan({text:tex});}};
    if(record.kind==='equation' && (record.tex?.length || 0)>8000)body.createEl('p',{text:t('公式较长，请打开笔记查看。')});
    else if(record.kind==='equation') math(Engine.taggedTex(record,key=>graph.resolveLabel(key,record.path)),true);
    else if(record.diagram || record.kind==='figure' || record.kind==='subfigure') body.createEl('p',{text:record.title || t('图表内容请打开笔记查看。')});
    else {
        const note=graph.notes.get(record.path);
        const excerpt=(note?.lines.slice(record.line+1,Math.min(record.endLine+1,record.line+14)).map(line=>Engine.quote(line).body).join('\n') || record.title || '').slice(0,1800);
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
        plugin.registerDomEvent(doc,'pointerover',event=>{if(event.pointerType==='touch')return;this.enter(event.target as Element | null);});
        plugin.registerDomEvent(doc,'focusin',event=>this.enter(event.target as Element | null));
        plugin.registerDomEvent(doc,'pointerout',event=>this.leave(event.relatedTarget as Node | null));
        plugin.registerDomEvent(doc,'focusout',event=>this.leave(event.relatedTarget as Node | null));
        plugin.registerDomEvent(doc,'click',event=>{
            const anchor=this.find(event.target as Element | null);if(!anchor)return;
            if(!(Platform.isMobile || this.touch) || event.ctrlKey || event.metaKey || event.button!==0 || !plugin.settings.referencePreview){this.hide();return;}
            const target=previewTarget(plugin,anchor);if(!target)return;
            event.preventDefault();event.stopImmediatePropagation();this.hide();
            const modal=new Modal(plugin.app);this.modal=modal;
            modal.titleEl.setText(t('引用内容预览'));renderReferencePreview(plugin,modal.contentEl,target,()=>modal.close());
            modal.onClose=()=>{if(this.modal===modal)this.modal=undefined;};modal.open();
        },true);
        plugin.registerDomEvent(doc,'keydown',event=>{if(event.key==='Escape')this.hide(true);else if(event.key==='Enter'&&this.find(event.target as Element | null))this.hide();},true);
        plugin.register(()=>this.destroy());
    }
    private find(node: Element | null) { return node?.closest?.<HTMLElement>('a[data-an-target],a[data-an-eqref]') || null; }
    private enter(node: Element | null) {
        if(this.restoringFocus || !this.plugin.settings.referencePreview || node?.closest('.an-reference-preview'))return;
        const anchor=this.find(node);if(!anchor || anchor===this.anchor && this.card)return;
        this.clear();this.timer=this.doc.defaultView!.setTimeout(()=>{if(anchor.isConnected)this.show(anchor);},250);
    }
    private leave(next: Node | null) {
        if(next && (this.anchor?.contains(next)||this.card?.contains(next))) {this.clear();return;}
        this.clear();this.timer=this.doc.defaultView!.setTimeout(()=>this.hide(),180);
    }
    private clear() {if(this.timer!==undefined)this.doc.defaultView!.clearTimeout(this.timer);this.timer=undefined;}
    show(anchor: HTMLElement) {
        const target=previewTarget(this.plugin,anchor);if(!target)return;
        this.hide();this.anchor=anchor;
        const card=this.doc.body.createDiv({cls:'an-reference-popover',attr:{role:'dialog','aria-label':t('引用内容预览')}});this.card=card;
        renderReferencePreview(this.plugin,card,target,()=>this.hide(true));
        const bounds=anchor.getBoundingClientRect(),viewport=this.doc.documentElement;
        card.style.left=Math.max(8,Math.min(bounds.left,viewport.clientWidth-card.offsetWidth-8))+'px';
        card.style.top=Math.max(8,Math.min(bounds.bottom+8,viewport.clientHeight-card.offsetHeight-8))+'px';
    }
    hide(restoreFocus=false) {this.clear();const anchor=this.anchor;this.card?.remove();this.card=undefined;this.anchor=undefined;if(restoreFocus){this.restoringFocus=true;anchor?.focus({preventScroll:true});this.restoringFocus=false;}}
    destroy(){this.hide();this.modal?.close();this.modal=undefined;}
}
