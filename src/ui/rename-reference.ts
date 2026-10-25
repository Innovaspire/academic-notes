import { Modal, FuzzySuggestModal, Setting, Notice, type ButtonComponent } from 'obsidian';
import type AcademicNotes from '../main';
import type { SourceRecord } from '../indexing/engine';
import Engine from '../indexing/engine';
import { t } from '../i18n';
import { refactorGraph, labelRenamePlan, applyReferenceChanges, type NoteChange } from '../workspace/refactor';
export class RenameReferencePicker extends FuzzySuggestModal<SourceRecord> {
    constructor(private plugin: AcademicNotes) { super(plugin.app); this.setPlaceholder(t('选择要重命名的标签')); }
    getItems() { return this.plugin.targets(); }
    getItemText(record: SourceRecord) { return `${Engine.refText(record,this.plugin.settings,record.id || undefined)} — ${record.path} ^${record.id}`; }
    onChooseItem(record: SourceRecord) { if(record.id)new RenameReferenceModal(this.plugin,record.path,record.id).open(); }
}
export class RenameReferenceModal extends Modal {
    private changes: NoteChange[] = [];
    private next: string;
    private applying=false;
    constructor(private plugin: AcademicNotes, private path: string, private label: string) { super(plugin.app);this.next=label; }
    onOpen() {
        this.titleEl.setText(t('重命名学术标签'));
        this.contentEl.createEl('p',{text:`${this.path} · ${this.label}`});
        this.contentEl.createEl('p',{text:t('先预览定义与引用的修改；代码示例和注释不会被替换。')});
        let confirm: ButtonComponent, undo: ButtonComponent, undoChanges: NoteChange[] = [];
        new Setting(this.contentEl).setName(t('新标签')).addText(input=>input.setValue(this.next).onChange(value=>{this.next=value.trim();this.changes=[];confirm?.setDisabled(true);}));
        const results=this.contentEl.createDiv({cls:'an-refactor-results'});
        new Setting(this.contentEl).addButton(button=>button.setButtonText(t('预览修改')).onClick(async()=>{
            if(this.applying)return;
            button.setDisabled(true);confirm.setDisabled(true);
            try {
                const next=this.next, graph=await refactorGraph(this.plugin);
                if(next!==this.next)return;
                this.changes=labelRenamePlan(graph,this.path,this.label,next);results.empty();
                results.createEl('p',{text:t('将修改 {0} 篇笔记、{1} 处内容。',this.changes.length,this.changes.reduce((sum,c)=>sum+c.count,0))});
                for(const change of this.changes){
                    const details=results.createEl('details');details.createEl('summary',{text:`${change.path} · ${change.count}`});
                    const before=change.before.split('\n'),after=change.after.split('\n');
                    const lines=Array.from({length:Math.max(before.length,after.length)},(_,i)=>before[i]===after[i]?'':`- ${before[i]||''}\n+ ${after[i]||''}`).filter(Boolean);
                    details.createEl('pre',{text:lines.slice(0,200).join('\n')});
                }
                confirm.setDisabled(!this.changes.length);
            }catch(error){this.plugin.fail(t('预览修改'),error);}finally{button.setDisabled(false);}
        })).addButton(button=>{confirm=button;button.setButtonText(t('应用修改')).setCta().setDisabled(true).onClick(async()=>{
            if(this.applying || !this.changes.length)return;
            this.applying=true;const changes=this.changes;button.setDisabled(true);
            try{await applyReferenceChanges(this.plugin,changes);this.changes=[];undoChanges=changes;undo.setDisabled(false);new Notice(t('标签及引用已更新。'));}
            catch(error){this.plugin.fail(t('重命名学术标签'),error);}
            finally{this.applying=false;}

        });}).addButton(button=>{undo=button;button.setButtonText(t('撤销改名')).setDisabled(true).onClick(async()=>{undo.setDisabled(true);try{await applyReferenceChanges(this.plugin,undoChanges.map(c=>({...c,before:c.after,after:c.before})));this.close();}catch(error){this.plugin.fail(t('撤销改名'),error);}});});
    }
}
