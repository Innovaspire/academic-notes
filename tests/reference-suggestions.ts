import test from 'node:test';
import assert from 'node:assert/strict';
import AcademicNotes from '../src/main';
import Engine from '../src/indexing/engine';
import { DEFAULTS } from '../src/settings';
import { ReferenceSuggest, referenceSuggestions } from '../src/ui/reference-suggest';
import { TFile } from './obsidian-mock';

function pluginWith(sources: [string,string][]) {
    const plugin = new AcademicNotes(); plugin.settings = {...DEFAULTS};
    plugin.graph = Engine.graph(sources.map(([path,text])=>Engine.parse(path,text)),plugin.settings); plugin.scheduleIndex=()=>{};
    return plugin;
}
function harness(initial: string) {
    let text = initial, writes = 0;
    const offset=(p:{line:number;ch:number})=>text.split('\n').slice(0,p.line).reduce((n,s)=>n+s.length+1,0)+p.ch;
    const pos=(at:number)=>{const lines=text.slice(0,at).split('\n');return {line:lines.length-1,ch:lines.at(-1)!.length};};
    const editor:any={getValue:()=>text,getLine:(line:number)=>text.split('\n')[line],getRange:(a:any,b:any)=>text.slice(offset(a),offset(b)),
        posToOffset:offset,offsetToPos:pos,replaceRange:(s:string,a:any,b:any)=>{text=text.slice(0,offset(a))+s+text.slice(offset(b));writes++;}};
    return {editor,pos,text:()=>text,writes:()=>writes};
}
test('suggestion scopes keep exact file/folder identity and show this-file once',()=>{
    const plugin=pluginWith([['foo.md',String.raw`$$x=1 \label{root}$$`],['foo/a.md',String.raw`$$y=2 \label{nested}$$`],['Foo.md',String.raw`$$z=3 \label{case}$$`]]);
    const root=referenceSuggestions(plugin,'eqref','foo.md','');
    assert.equal((root[0] as any).current,true);
    assert.equal(root.filter(x=>x.type==='file'&&x.path==='foo.md').length,1);
    assert.ok(root.some(x=>x.type==='folder'&&x.path==='foo'));
    for(const [path,id] of [['foo.md','root'],['Foo.md','case'],['foo/a.md','nested']]) {
        const entries=referenceSuggestions(plugin,'eqref','elsewhere.md','',{type:'file',path});
        assert.deepEqual(entries.map(x=>x.type==='record'&&x.record.id),[id]);
    }
    const folder=referenceSuggestions(plugin,'eqref','elsewhere.md','',{type:'folder',path:'foo'});
    assert.deepEqual(folder.map(x=>x.type!=='record'&&x.path),['foo/a.md']);
    assert.ok(!referenceSuggestions(plugin,'eqref','elsewhere.md','').some(x=>x.type!=='record'&&x.current));
});
test('manual-first is optional and exact row-label matches take priority',()=>{
    const plugin=pluginWith([['a.md',String.raw`$$x=1 \label{auto}$$`+'\n\n'+String.raw`$$y=2 \tag{7}\label{manual}$$`],['rows.md',String.raw`$$\begin{align*}a=b\label{first}\\c=d\label{second}\end{align*}$$`]]);
    const ids=()=>referenceSuggestions(plugin,'eqref','a.md','',{type:'file',path:'a.md'}).map(x=>x.type==='record'&&x.record.id);
    assert.deepEqual(ids(),['auto','manual']);plugin.settings.referenceManualFirst=true;assert.deepEqual(ids(),['manual','auto']);
    const row=referenceSuggestions(plugin,'eqref','a.md','second',{type:'file',path:'rows.md'});
    assert.equal(row[0].type==='record'&&row[0].record.id,'second');
});
test('suggestion commands retain inline/display math, row labels and prose insertion',()=>{
    const plugin=pluginWith([['target.md',String.raw`$$x=1 \label{eq:x}$$`],['thm.md','> [!thm] Result ^thm\n> Body']]);
    let selected:any[]=[];plugin.insertReference=async(...args:any[])=>{selected=args;};
    for(const [source,math,kind,expected] of [[String.raw`$\ref{eq:x}$`,true,'equation','eqref'],[String.raw`$$\ref{thm}$$`,true,'theorem','ref'],[String.raw`See \eqref{eq:x}`,false,'equation',undefined],[String.raw`\tref{thm}`,false,'theorem',undefined]] as const) {
        const h=harness(source),suggest=new ReferenceSuggest(plugin),file={path:'active.md'} as any;
        const ctx=suggest.onTrigger(h.pos(source.indexOf('}')),h.editor,file)!;
        suggest.context={...ctx,editor:h.editor,file}; assert.equal(suggest.math,math);
        const record=plugin.targets(false).find(r=>r.kind===kind)!;
        suggest.selectSuggestion({type:'record',record}); assert.equal(selected[5],expected);assert.equal(selected[6],record.id);
    }
    for(const source of ['```tex\n'+String.raw`$\eqref{eq:x}`+'\n```','`'+String.raw`$\eqref{eq:x}`+'`']){
        const h=harness(source),suggest=new ReferenceSuggest(plugin);suggest.onTrigger(h.pos(source.indexOf('}')),h.editor,{path:'active.md'} as any);assert.equal(suggest.math,false);
    }
    assert.ok(referenceSuggestions(plugin,'eqref','active.md','').every(x=>x.type!=='file'||x.path==='target.md'));
    assert.ok(referenceSuggestions(plugin,'tref','active.md','').every(x=>x.type!=='file'||x.path==='thm.md'));
});
test('insertion uses a unique alias, rejects explicit duplicates, and retains title IDs',async()=>{
    const source=String.raw`$$x=1 \label{dup}\label{unique}$$`+'\n\n'+String.raw`$$y=2 \label{dup}$$`+'\n\n'+String.raw`\eqref{}`;
    const plugin=pluginWith([['a.md',source]]),file=Object.assign(new TFile(),{path:'a.md'});
    plugin.app={vault:{getAbstractFileByPath:()=>file}} as any;
    const target=plugin.graph!.notes.get('a.md')!.records[0];
    const h=harness(source),start=source.lastIndexOf('\\eqref');
    await assert.rejects(plugin.insertReference(h.editor,file,target,h.pos(start),h.pos(source.length),'eqref','dup'));
    assert.equal(h.writes(),0);
    await plugin.insertReference(h.editor,file,target,h.pos(start),h.pos(source.length),'eqref');
    assert.ok(h.text().endsWith(String.raw`\eqref{unique}`));
    const titleSource='> [!thm] Result ^existing\n> Body\n\nReference: ',titlePlugin=pluginWith([['a.md',titleSource]]),titleHarness=harness(titleSource);
    titlePlugin.app=plugin.app;
    await titlePlugin.insertReference(titleHarness.editor,file,titlePlugin.targets(false)[0],titleHarness.pos(titleSource.length),titleHarness.pos(titleSource.length));
    assert.ok(titleHarness.text().endsWith('[[#^existing]]'));assert.ok(!titleHarness.text().includes('^an-'));
});
