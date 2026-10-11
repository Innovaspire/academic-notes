import { TFile, MarkdownView } from 'obsidian';
import Engine from '../src/indexing/engine';
import { DEFAULTS } from '../src/settings';
import { ReferenceAuditModal, CatalogModal, ProfileModal, refreshCatalog } from '../src/ui/workspace-tools';
import { exportProfile } from '../src/workspace/profiles';
import { setLanguage } from '../src/i18n';
const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const wait=()=>new Promise(resolve=>setTimeout(resolve,50));
export async function runWorkspaceRegressions() {
    setLanguage('en');
    const files=new Map<string,any>(), texts=new Map<string,string>();
    const add=(path:string,source:string)=>{const file=Object.assign(new TFile(),{path,basename:path.replace(/\.md$/,''),extension:'md'});files.set(path,file);texts.set(path,source);return file;};
    const source=add('Synthetic.md','## Topic\n\n> [!thm] One\n> Text\n\n^one\n\n[[#^missing]]');
    let active=source,opened:any,saveCount=0;
    const app:any={workspace:{getActiveFile:()=>active,getLeaf:()=>({openFile:async(file:any)=>{opened=file;}})},vault:{getAbstractFileByPath:(path:string)=>files.get(path),read:async(file:any)=>texts.get(file.path),
        create:async(path:string,text:string)=>add(path,text),process:async(file:any,fn:any)=>{texts.set(file.path,fn(texts.get(file.path)));}},metadataCache:{getFileCache:()=>({})}};
    const plugin:any={app,settings:{...DEFAULTS},graph:Engine.graph([Engine.parse(source.path,texts.get(source.path)!)]),rebuild:async()=>{},resolver:()=>null,mkdir:async()=>{},saveSettings:async()=>{saveCount++;},applyAppearance(){},fail(_where:string,error:unknown){throw error;}};
    const click=(modal:any,text:string)=>{const button=[...modal.contentEl.querySelectorAll('button')].find((el:any)=>el.textContent===text) as HTMLButtonElement;check(button,'Missing '+text);button.click();};
    const audit:any=new ReferenceAuditModal(plugin);audit.open();click(audit,'Run check');await wait();
    check(audit.contentEl.textContent.includes('Target block ID does not exist'),'Audit results must explain missing block');
    check(audit.contentEl.textContent.includes('Synthetic.md:8'),'Audit must retain the exact source line');
    click(audit,'Go to location');await wait();check(opened===source,'Finding must open its source note');
    const catalog:any=new CatalogModal(plugin);catalog.open();click(catalog,'Preview index');await wait();
    check(catalog.contentEl.querySelector('pre').textContent.includes('Synthetic#^one'),'Preview must contain portable block links');
    click(catalog,'Create or update');await wait();
    const index=files.get('Academic index.md');check(index && opened===index,'Creating the index must create and open a Markdown note');
    texts.set(index.path,'Personal introduction\n\n'+texts.get(index.path)+'\nPersonal conclusion');active=index;
    await refreshCatalog(plugin);check(texts.get(index.path)!.startsWith('Personal introduction')&&texts.get(index.path)!.endsWith('Personal conclusion'),'Refreshing must preserve handwritten text');
    let buffer=texts.get(index.path)!+'\nUnsaved handwriting',edits=0;
    const view=Object.assign(new MarkdownView(),{file:index,getMode:()=> 'source',editor:{getValue:()=>buffer,
        offsetToPos:(offset:number)=>{const lines=buffer.slice(0,offset).split('\n');return {line:lines.length-1,ch:lines.at(-1)!.length};},
        replaceRange:(value:string,from:any,to:any)=>{const lines=buffer.split('\n'),offset=(pos:any)=>lines.slice(0,pos.line).reduce((sum:number,line:string)=>sum+line.length+1,0)+pos.ch;buffer=buffer.slice(0,offset(from))+value+buffer.slice(offset(to));edits++;}}});
    app.workspace.getLeavesOfType=()=>[{view}];
    await refreshCatalog(plugin);
    check(edits===1&&buffer.endsWith('Unsaved handwriting'),'Open source buffers must retain unsaved handwriting through one undoable region edit');
    check(!texts.get(index.path)!.includes('Unsaved handwriting'),'Updating an open editor must not overwrite the disk behind it');
    const profile:any=new ProfileModal(plugin);profile.open();
    profile.contentEl.querySelector('textarea').value=exportProfile({...DEFAULTS,lightPalette:'sakura'});
    const activate=profile.contentEl.querySelector('input[type=checkbox]');activate.checked=true;activate.dispatchEvent(new Event('change'));
    click(profile,'Apply import');await wait();check(saveCount===0,'Import must require a review of the concrete profile');
    click(profile,'Preview import');await wait();click(profile,'Apply import');await wait();
    check(saveCount===1 && plugin.settings.lightPalette==='sakura','Reviewed import must apply the selected palette');
    check(plugin.settings.exportFolder==='_exports','Import must preserve local paths');
    return 'Workspace tools: reference navigation, Markdown create/update and reviewed profile import passed';
}
