import test from 'node:test';
import assert from 'node:assert/strict';
import Engine from '../src/indexing/engine';
import { auditReferences } from '../src/workspace/audit';
import { catalogBody } from '../src/workspace/catalog';
test('row modes respect suppression, manual tags and aliases', () => {
 const source=String.raw`$$
\begin{align*}
a &= b \label{one} \\
c &= d \label{two} \label{alias} \\
e &= f \notag \label{quiet} \\
g &= h \tag{X} \label{manual} \\
i &= j
\end{align*}
$$

[[#^alias]] [[#^quiet]]`;
 for(const [mode,expected] of [['all',['1','2','','X','3']],['referenced',['','1','','X','']],['none',['','','','X','']]] as const){
 const note=Engine.parse('rows.md',source),graph=Engine.graph([note],{equationMode:mode});
 assert.deepEqual(note.equations[0].rows!.map(r=>r.number),expected);
 assert.equal(Engine.referenceNumber(note.equations[0],'alias'),expected[1]);
 assert.ok(auditReferences(graph).some(i=>i.code==='unnumbered-target'));
 }
});
test('outer environment conversion preserves leading and trailing comments',()=>{
 const note=Engine.parse('comment.md',String.raw`$$
% leading comment
\begin{aligned}
a &= b \label{a} \\
c &= d \label{b}
\end{aligned} % trailing comment
$$`);
 Engine.graph([note],{equationMode:'all'});
 const tex=Engine.taggedTex(note.equations[0]);
 assert.ok(tex.includes('% leading comment'));
 assert.ok(tex.includes('\\begin{align*}')&&tex.includes('\\end{align*}'));
 assert.ok(tex.endsWith('% trailing comment'));
 assert.equal((tex.match(/\\tag\{/g)||[]).length,2);
});
test('single-equation multiline structures retain one number and catalog links are native',()=>{
 for(const env of ['split','multline*']){
 const source=String.raw`$$
\begin{ENV}
a=b \\
c=d \label{eq:single}
\end{ENV}
$$`.replaceAll('ENV',env);
 const note=Engine.parse('single.md',source),graph=Engine.graph([note],{equationMode:'all'});
 assert.equal(note.equations[0].rows,undefined);assert.equal(note.equations[0].number,'1');
 const body=catalogBody(graph,{version:1,scope:'vault',source:'',types:['equation'],group:'type',unnumbered:true},new Set(['single.md']),'index.md');
 assert.ok(!body.includes('#^eq:single'));assert.ok(body.includes('[[single|'));
 }
});

test('row spacing, same-row aliases and duplicate labels preserve target identity',()=>{
 const source=String.raw`$$\begin{aligned}[t]a=b \label{x} \label{alias} \\[4pt] c=d \label{y}\end{aligned}$$`;
 const note=Engine.parse('spacing.md',source);Engine.graph([note],{equationMode:'all'});
 assert.deepEqual(note.equations[0].rowNumbers,{x:'1',alias:'1',y:'2'});
 assert.ok(Engine.taggedTex(note.equations[0]).includes(String.raw`\\[4pt]`));
 const duplicate=Engine.parse('duplicate.md',source.replace('\\label{y}','\\label{x}'));
 const graph=Engine.graph([duplicate],{equationMode:'all'});
 assert.equal(graph.resolve('#^x',duplicate.path),null);
});

test('explicit row tags are checked individually for number collisions',()=>{
 const note=Engine.parse('tags.md',String.raw`$$\begin{align*}a=b \label{one}\tag{A} \\ c=d \label{two}\tag{A}\end{align*}$$`);
 const graph=Engine.graph([note]);
 assert.equal(note.warnings.length,0);
 assert.ok(auditReferences(graph).some(i=>i.code==='number-conflict'));
});
