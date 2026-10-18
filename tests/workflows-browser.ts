import { MarkdownView, TFile } from 'obsidian';
import AcademicNotes from '../src/main';
import Engine from '../src/indexing/engine';
import { DEFAULTS } from '../src/settings';
import { BookPicker, reviewBookReferences } from '../src/ui/book';
import { ProgressModal } from '../src/ui/modals';
import { frontmatter } from '../src/workspace/notes';
import { renameCatalogSources } from '../src/ui/workspace-tools';
import { renderCatalog, readCatalog } from '../src/workspace/catalog';
import { renderEnvironmentSettings } from '../src/ui/environment-settings';
import { DiagramEditor } from '../src/diagrams/editor';
import { setLanguage } from '../src/i18n';
const check = (value: unknown, message: string) => { if (!value) throw new Error(message); };
const wait = () => new Promise(r => setTimeout(r, 100));
export async function runWorkflowRegressions() {
    setLanguage('en');
    const files = new Map<string, TFile>(), texts = new Map<string, string>();
    const add = (path:string, text:string) => { const f = Object.assign(new TFile(), {path, basename:path.replace(/\.md$/,''),extension:'md',stat:{mtime:1}}); files.set(path,f);texts.set(path,text);return f; };
    const a = add('A.md','> [!thm] First\n> Body\n'), b = add('B.md','References: ');
    let buffer = texts.get(b.path)!, edits = 0, active = b;
    const editor:any = { getValue:()=>buffer, getCursor:()=>editor.offsetToPos(buffer.length), posToOffset:(p:any)=>buffer.split('\n').slice(0,p.line).reduce((n:number,s:string)=>n+s.length+1,0)+p.ch,
        offsetToPos:(n:number)=>{const parts=buffer.slice(0,n).split('\n');return {line:parts.length-1,ch:parts.at(-1)!.length};},
        replaceRange:(text:string,from:any,to=from)=>{const start=editor.posToOffset(from),end=editor.posToOffset(to);buffer=buffer.slice(0,start)+text+buffer.slice(end);edits++;} };
    const view = Object.assign(new MarkdownView(), {file:b,editor,getMode:()=> 'source'});
    const app:any = { workspace:{getActiveFile:()=>active,getLeavesOfType:()=>[{view}],openLinkText:async()=>{},getLeaf:()=>({openFile:async(f:TFile)=>active=f})}, metadataCache:{getFileCache:(f:TFile)=>({frontmatter:frontmatter(texts.get(f.path)!).data}),getFirstLinkpathDest:()=>null},
        vault:{getMarkdownFiles:()=>[...files.values()],getAbstractFileByPath:(p:string)=>files.get(p),cachedRead:async(f:TFile)=>texts.get(f.path),read:async(f:TFile)=>texts.get(f.path),process:async(f:TFile,fn:any)=>texts.set(f.path,fn(texts.get(f.path))),create:async(p:string,s:string)=>add(p,s)} };
    const plugin = new AcademicNotes(app,{} as any);plugin.active=true;plugin.settings={...DEFAULTS};plugin.mkdir=async()=>{};plugin.saveSettings=async()=>{};
    plugin.fail=(_where,error)=>{throw error;};
    await plugin.rebuild();
    await plugin.insertReference(editor,b,plugin.graph!.notes.get(a.path)!.records[0]);
    const target=Engine.parse(a.path,texts.get(a.path)!);check(target.records[0].id && buffer.includes('#^'+target.records[0].id),'Unlabelled cross-file targets must get a real ID and reference');
    check(texts.get(b.path)==='References: ' && edits===1,'Reference insertion must use the unsaved origin buffer');
    const race = add('Race.md','> [!lem] Race\n> Body'), other = add('Other.md',buffer), process = app.vault.process;
    await plugin.rebuild(); const beforeRace = buffer;
    app.vault.process = async (f:TFile,fn:any) => { await process(f,fn); view.file=other; };
    let rejected=false;
    try { await plugin.insertReference(editor,b,plugin.graph!.notes.get(race.path)!.records[0]); } catch { rejected=true; }
    check(rejected && buffer===beforeRace,'Switching to an identical-text note during a target write must not insert into the wrong note');
    app.vault.process=process;view.file=b;
    // A same-note label inserted before the reference must not move the insertion into unrelated text.
    view.file=a;active=a;buffer='> [!thm] Another\n> Body\n\nReference: ';await plugin.rebuild();
    await plugin.insertReference(editor,a,plugin.graph!.notes.get(a.path)!.records[0]);
    const same=Engine.parse(a.path,buffer);check(same.refs.length===1&&same.refs[0].block===same.records[0].id,'Same-note offsets must account for the newly inserted ID');
    // Save then reopen a manifest, retaining user properties and handwritten prose.
    const book:any=new BookPicker(plugin);book.open();book.selected=[a,b];book.title='Study: notes';book.titles.set(a.path,'Chapter A');book.destination='Collection.md';
    const click=(root:HTMLElement,label:string)=>{const b=[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);check(b,'Missing '+label);b!.click();};
    const excluded=add('Excluded.md','A note');
    plugin.settings.excludedFolders='Excluded.md';
    const review=reviewBookReferences(plugin,{files:[{file:excluded,title:'Excluded'}],options:{book:true,title:'Review',subtitle:'',tocDepth:3}});await wait();
    const reviewModal=[...document.querySelectorAll<HTMLElement>('.modal')].find(m=>m.textContent?.includes('Target is not indexed; cannot check'))!;
    check(reviewModal,'Preflight must report excluded source chapters');click(reviewModal,'Cancel');check(await review===false,'Closing preflight must not launch an export');plugin.settings.excludedFolders='';
    click(book.contentEl,'Save manifest');await wait();const manifest=files.get('Collection.md')!;check(manifest,'Manifest must be saved');
    texts.set(manifest.path,texts.get(manifest.path)!+'\nHandwritten introduction');active=manifest;
    const reopened:any=new BookPicker(plugin);reopened.open();await wait();
    check(reopened.selected.length===2&&reopened.titles.get(a.path)==='Chapter A','Manifest must restore order and chapter titles');
    reopened.subtitle='Updated';click(reopened.contentEl,'Save manifest');await wait();check(texts.get(manifest.path)!.endsWith('Handwritten introduction'),'Manifest updates preserve the body');book.close();reopened.close();
    const index=add('Index.md','Before\n'+renderCatalog({version:1,scope:'note',source:'A.md',types:['thm'],group:'type',unnumbered:true},'Old list')+'\nAfter');
    await renameCatalogSources(plugin,'A.md','Renamed.md');check(readCatalog(texts.get(index.path)!)?.source==='Renamed.md','Rename must update generated configuration');
    // Environment deletion is reviewed, never performed by the first click.
    plugin.settings.customEnvironments=JSON.stringify({observation:{name:'Observation',abbr:'obs',style:'thm',numbered:true}});add('Usage.md','> [!observation] Used\n> Body');await plugin.rebuild();
    const host=document.body.createDiv();renderEnvironmentSettings(host,plugin,{selected:'observation'});click(host,'Delete environment');await wait();
    check(Engine.environments(plugin.settings).observation,'Delete must first show usage, preserving the definition');
    const modal=[...document.querySelectorAll<HTMLElement>('.modal')].find(m=>m.textContent?.includes('Used in 1 indexed notes and 1 blocks.'));check(modal,'Usage review must count current records');
    click(modal!,'Delete definition, keep notes');await wait();check(!Engine.environments(plugin.settings).observation&&texts.get('Usage.md')!.includes('[!observation]'),'Confirmed deletion must preserve note contents');modal?.remove();host.remove();
    let cancelled=false;const progress=new ProgressModal(app,'Test',()=>cancelled=true);progress.open();click(progress.contentEl,'Cancel export');check(cancelled&&progress.cancelButton?.disabled,'Cancellation must invoke the controller and disable repeat clicks');progress.done();progress.close();
    const snapshot = plugin.snapshot;
    plugin.snapshot = async (_selection,_log,signal) => new Promise((_resolve,reject) => signal!.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
    const exporting = plugin.exportSelection({files:[{file:a,title:'A'}],options:{book:false,title:'Cancel test',subtitle:'',tocDepth:3}},false);
    await wait();const exportModal=[...document.querySelectorAll<HTMLElement>('.modal')].find(m=>m.textContent?.includes('Cancel export'))!;
    click(exportModal,'Cancel export');await exporting;check(!plugin.busy && plugin.pdfJobs.size===0,'Cancellation during snapshot rendering must finish and release the export job');exportModal.remove();plugin.snapshot=snapshot;
    const diagramHost=document.body.createDiv(), diagram=new DiagramEditor(diagramHost);diagram.mode='arrows';diagram.choose('n-0-0');diagram.choose('n-0-1');diagram.head.value='injective';diagram.head.dispatchEvent(new Event('change'));diagram.parallel.click();
    diagram.head.value='surjective';diagram.head.dispatchEvent(new Event('change'));diagram.arrowLabel.value='\\alpha';diagram.arrowLabel.dispatchEvent(new Event('input'));await wait();await wait();
    check(diagram.data.arrows.length===2,'Parallel-arrow control creates a second independent edge');
    const paths=[...diagramHost.querySelectorAll('[data-an-arrow] > path[marker-end]')];check(paths.length===2&&paths[0].getAttribute('d')!==paths[1].getAttribute('d'),'Parallel paths must be distinct');
    check(paths.some(p=>p.getAttribute('marker-end')?.includes('-onto')),'Surjection uses a double arrowhead');
    diagram.head.value='isomorphism';diagram.head.dispatchEvent(new Event('change'));await wait();await wait();check(!!diagramHost.querySelector('svg.an-diagram-math[aria-label*="cong"]'),'Isomorphism label is rendered as math');
    (globalThis as any).academicWorkflowPreview=diagram.preview.outerHTML;
    diagramHost.remove();plugin.active=false;
    return 'Book save/reopen, unsaved-buffer references, rename tracking, environment usage, cancellation and parallel arrows passed';
}
