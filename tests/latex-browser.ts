import { renderMath } from 'obsidian';
import Engine from '../src/indexing/engine';
import Doc from '../src/export/document';
import { prepareMathLinks } from '../src/export/math-links';
import { setMathOutput } from './browser-host';
export function runLatexExportRegression() {
 setMathOutput('svg');
 const a=Engine.parse('A.md',String.raw`$$\begin{align*}a=b \label{eq:first} \\ c=d \label{eq:second}\end{align*}$$`);
 const b=Engine.parse('B.md',String.raw`$$\eqref{A#^eq:second}$$

By $\eqref{A#^eq:second}$.`);
 const graph=Engine.graph([a,b],{equationMode:'all'},undefined,new Map([['A.md',{chapter:1,mode:'chapter'}],['B.md',{chapter:2,mode:'chapter'}]]));
 const root=document.createElement('main');root.id='phb-document';document.body.append(root);
 for(const note of [a,b]){
  const section=document.createElement('section');section.className='phb-chapter';section.dataset.path=note.path;if(note===b)section.style.breakBefore='page';root.append(section);
  const h=document.createElement('h1');h.textContent=note.path;section.append(h);
  for(const eq of note.equations){
   const box=document.createElement('div');box.dataset.phbBlocks=JSON.stringify(eq.ids);section.append(box);
   box.append(renderMath(Engine.taggedTex(eq,label=>graph.resolveLabel(label,note.path),true),true));
  }
  for(const inline of note.inlineMath){const p=section.createEl('p');p.append(renderMath(Engine.referenceTex(inline.tex,label=>graph.resolveLabel(label,note.path),true),false));}
  prepareMathLinks(section,graph,note.path);
 }
 if(root.querySelector('[data-mml-node="merror"],mjx-merror'))throw new Error('Invalid exported equation');
 const meta=Doc.prepare(root,{book:true,preNumbered:true,title:'Equation references'});
 const ref=root.querySelector<HTMLElement>('a[data-phb-canonical="true"]');
 if(!ref?.dataset.phbResolved || ref.getAttribute('href')!=='#'+ref.dataset.phbResolved)throw new Error('Second-row SVG reference did not resolve');
 if(Engine.referenceNumber(a.equations[0],'eq:second')!=='1.2')throw new Error('Wrong chapter row number');
 const script=document.createElement('script');script.id='phb-meta';script.type='application/json';script.textContent=JSON.stringify(meta);
 const result=root.outerHTML+script.outerHTML;root.remove();return {message:'LaTeX row/chapter numbers and SVG export destinations passed',markup:result};
}
