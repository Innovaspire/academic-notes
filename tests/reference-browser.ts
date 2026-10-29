import { renderMath, Platform } from 'obsidian';
import Engine from '../src/indexing/engine';
import { DEFAULTS } from '../src/settings';
import { setMathOutput } from './browser-host';
import { renderFragment } from '../src/rendering/adapters';
import { ReferencePreviews } from '../src/ui/reference-preview';
import { setLanguage } from '../src/i18n';
import { runSuggestionBrowserRegressions } from './suggestions-browser';
const check=(value:unknown,message:string)=>{if(!value)throw new Error(message);};
const wait=()=>new Promise(resolve=>setTimeout(resolve,320));
export async function runReferenceWorkflowRegressions(){
 setLanguage('en');
 const source=String.raw`$$x=1 \label{eq:a}$$

First $x+1$ then $\eqref{eq:a}$.`;
 const note=Engine.parse('Math.md',source),graph=Engine.graph([note]);
 for(const mode of ['chtml','svg'] as const){
  setMathOutput(mode);
  const host=document.body.createDiv({cls:'markdown-rendered'});
  const display=host.createDiv();display.append(renderMath('x=1',true));
  const paragraph=host.createEl('p');paragraph.append(renderMath('x+1',false),renderMath('\\eqref{eq:a}',false));
  renderFragment(host,note,graph,()=>({lineStart:0,lineEnd:10}));
  const math=[...paragraph.querySelectorAll<HTMLElement>('mjx-container')];
  check(!math[0].dataset.anMath,'Ordinary inline math must stay native');
  check(math[1].dataset.anMath?.includes('an-eqref') && math[1].getAttribute('display')!=='true','Inline reference must resolve without becoming display math');
  check(!host.querySelector('[data-mml-node="merror"],mjx-merror'),'Resolved inline reference must render without math errors');
  const rendered=math[1].innerHTML;renderFragment(host,note,graph,()=>({lineStart:0,lineEnd:10}));
  check(rendered===math[1].innerHTML && note.source===source,'Repeated rendering must preserve math nodes and Markdown');
  const cleanup:(()=>void)[]=[];let opened=0;
  const plugin:any={graph,settings:{...DEFAULTS},app:{},openRecord:async()=>{opened++;},recordError:(_w:string,e:unknown)=>{throw e;},fail:(_w:string,e:unknown)=>{throw e;},register:(fn:()=>void)=>cleanup.push(fn),registerDomEvent:(target:EventTarget,type:string,fn:EventListener,options:any)=>{target.addEventListener(type,fn,options);cleanup.push(()=>target.removeEventListener(type,fn,options));}};
  const previews=new ReferencePreviews(plugin),link=math[1].querySelector<HTMLElement>('a[data-an-eqref]')!;
  const focus=document.activeElement;
  link.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await wait();
  check(!!document.querySelector('.an-reference-popover') && document.activeElement===focus,'Desktop hover must preview without stealing focus');
  (globalThis as any).academicReferencePreview=document.querySelector('.an-reference-popover')!.outerHTML;
  check(document.querySelector('.an-reference-popover summary')?.textContent==='Referenced 1 times','Preview must show incoming references');
  document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await wait();
  check(!document.querySelector('.an-reference-popover'),'Escape must dismiss without reopening on restored focus');
  const nestedSource=['> [!thm] Outer','> body','> > [!lemma] Inner','> > inner body ^lem-nested'].join('\n');
  const nestedGraph=Engine.graph([Engine.parse('Nested.md',nestedSource)]);
  const nestedPlugin={...plugin,graph:nestedGraph};
  const nestedPreviews=new ReferencePreviews(nestedPlugin);
  const nestedAnchor=document.body.createEl('a',{href:'#^lem-nested',attr:{'data-an-target':'#^lem-nested','data-an-source':'Nested.md'}});
  nestedAnchor.textContent='nested lemma';
  nestedAnchor.dispatchEvent(new PointerEvent('pointerover',{bubbles:true,pointerType:'mouse'}));await wait();
  const nestedCard=document.querySelector<HTMLElement>('.an-reference-popover');
  check(!!nestedCard?.querySelector('.callout.an-reference-callout'),'Nested preview must recreate the callout frame');
  check(!nestedCard?.querySelector('blockquote'),'Nested preview must not render the source blockquote prefixes');
  nestedPreviews.destroy();nestedAnchor.remove();
  check(!document.querySelector('.an-reference-popover'),'Nested preview must close cleanly');
  const originalMobile=Platform.isMobile;Object.assign(Platform,{isMobile:true});
  link.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true}));
  const modal=document.querySelector<HTMLElement>('.an-reference-preview');check(modal && opened===0,'Mobile tap must preview before navigating');
  [...modal!.querySelectorAll('button')].find(b=>b.textContent==='Open target')!.click();
  check(opened===1,'Preview open action must navigate exactly once');
  Object.assign(Platform,{isMobile:originalMobile});previews.destroy();cleanup.reverse().forEach(fn=>fn());host.remove();
 }
 setMathOutput('svg');await runSuggestionBrowserRegressions();return 'Inline CHTML/SVG references, stable rerenders, previews and source-preserving suggestion browsing passed';
}
