import test from 'node:test';
import assert from 'node:assert/strict';
import Engine from '../src/indexing/engine';
import { labelRenamePlan, pathRenamePlan, applyReferenceChanges } from '../src/workspace/refactor';
import { TFile } from 'obsidian';

test('inline LaTeX references participate in numbering and preserve exact quoted offsets',()=>{
 const source=String.raw`$$x=1 \label{eq:a}$$

> [!proof]
> By $\eqref{eq:a}$, we have $x=1$.
> $$
> \ref{eq:a}
> $$`;
 const note=Engine.parse('A.md',source),graph=Engine.graph([note]);
 assert.equal(note.equations[0].number,'1');assert.equal(note.inlineMath.length,2);
 assert.equal(note.refs.length,2);
 for(const ref of note.refs)assert.equal(source.slice(ref.from,ref.to),ref.raw);
 assert.match(Engine.referenceTex(note.inlineMath[0].tex,label=>graph.resolveLabel(label,note.path),true),/an-eqref:/);
 const ignored=Engine.parse('ignore.md',String.raw`---
math: '$\eqref{a}$'
---
`+'`$\\eqref{a}$`\n```tex\n$\\eqref{a}$\n```\n'+String.raw`Escaped \$\eqref{a}\$; $x % \eqref{a}
$`);
 assert.equal(ignored.refs.length,0);
 assert.equal(Engine.mathSpans('text $\\eqref{a',true).at(-1)?.closed,false);
 assert.equal(Engine.mathSpans('`$\\eqref{a',true).length,0);
});

test('rename labels updates definitions, all reference forms and aliases but not examples',()=>{
 const a=Engine.parse('A.md',String.raw`$$x=1 \label{old}$$

^old

> [!proof] [[#^old|given]]
> By $\eqref{old}$.

`+'`\\label{old}`\n```tex\n\\label{old}\n```');
 const b=Engine.parse('B.md',String.raw`[[A#^old|alias]] and $\ref{A#^old}$ and [equation](A.md#^old)`);
 const graph=Engine.graph([a,b]);
 const changes=labelRenamePlan(graph,'A.md','old','new');assert.equal(changes.length,2);
 assert.ok(changes[0].after.includes(String.raw`\label{new}`));assert.ok(changes[0].after.includes('^new'));
 assert.ok(changes[0].after.includes(String.raw`\eqref{new}`));
 assert.ok(changes[0].after.includes('`\\label{old}`'));
 assert.ok(changes[1].after.includes('[[A#^new|alias]]'));
 assert.ok(changes[1].after.includes('[equation](A.md#^new)'));
 const rebuilt=Engine.graph(changes.map(c=>Engine.parse(c.path,c.after)));
 assert.ok([...rebuilt.notes.values()].every(n=>n.refs.every(r=>r.target)));
 assert.throws(()=>labelRenamePlan(graph,'A.md','old','bad:label'));
});

test('file and folder moves maintain LaTeX paths, relative outgoing references and YAML comments',()=>{
 const target=Engine.parse('New/A.md','$$x=1$$\n^a');
 const b=Engine.parse('B.md',String.raw`By $\eqref{Old/A#^a}$; keep \eqref{Old/A#^a} outside math.`);
 const outgoing=Engine.parse('New/C.md',String.raw`$\ref{../Other#^x}$`);
 const other=Engine.parse('Other.md','$$y=1$$\n^x');
 const book=Engine.parse('Book.md','---\nprivate: keep # note\nphb-book:\n  files:\n    - path: Old/A.md # chapter\n      title: Custom title\n---\nHandwritten body.');
 const changes=pathRenamePlan([target,b,outgoing,other,book],'Old','New');
 assert.ok(changes.find(c=>c.path==='B.md')?.after.includes(String.raw`$\eqref{New/A#^a}$`));
 assert.ok(changes.find(c=>c.path==='B.md')?.after.includes(String.raw`keep \eqref{Old/A#^a} outside math`));
 assert.ok(changes.find(c=>c.path==='New/C.md')?.after.includes(String.raw`\ref{Other#^x}`));
 const after=changes.find(c=>c.path==='Book.md')!.after;
 for(const text of ['New/A.md','# chapter','# note','Custom title','Handwritten body.'])assert.ok(after.includes(text));
});

test('reference changes reject stale previews and roll back completed writes on a later conflict',async()=>{
 const texts=new Map([['A.md','a'],['B.md','b']]);
 const files=new Map([...texts].map(([path])=>[path,Object.assign(new TFile(),{path})]));
 let conflict=false;
 const plugin:any={dirty:new Map(),scheduleIndex(){},app:{workspace:{getLeavesOfType:()=>[]},vault:{
 getAbstractFileByPath:(path:string)=>files.get(path),read:async(f:TFile)=>texts.get(f.path),
 process:async(f:TFile,update:(text:string)=>string)=>{if(conflict&&f.path==='B.md')texts.set('B.md','concurrent edit');texts.set(f.path,update(texts.get(f.path)!));}
 }}};
 const plan=[{path:'A.md',before:'a',after:'aa',count:1},{path:'B.md',before:'b',after:'bb',count:1}];
 conflict=true;await assert.rejects(applyReferenceChanges(plugin,plan));
 assert.equal(texts.get('A.md'),'a');assert.equal(texts.get('B.md'),'concurrent edit');
 await assert.rejects(applyReferenceChanges(plugin,plan));assert.equal(texts.get('A.md'),'a');
});
