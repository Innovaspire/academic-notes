import { webkit } from 'playwright';
import { build } from 'esbuild';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { typographyClient } from './typography-client.mjs';

// Isolated synthetic host: no connection to a real vault or an existing browser.
const imports = {runUiRegressions:'browser-regression',runReferenceWorkflowRegressions:'reference-browser',runLatexExportRegression:'latex-browser',runWorkflowRegressions:'workflows-browser',runFeatureRegressions:'feature-browser',runEditorIdleRegressions:'editor-idle-browser',runKpLiveRegressions:'kp-live-browser'};
const client = (await build({stdin:{contents:Object.entries(imports).map(([fn,file])=>`import {${fn}} from './tests/${file}'; globalThis.${fn}=${fn};`).join('\n'),resolveDir:process.cwd()},bundle:true,write:false,format:'iife',platform:'browser',plugins:[typographyClient],loader:{'.css':'text'},external:['electron','@electron/remote'],alias:{obsidian:resolve('tests/browser-host.ts')}})).outputFiles[0].text;
const css = await readFile('styles.css','utf8');
const browser = await webkit.launch({headless:true});
await mkdir('output/playwright',{recursive:true});
try {
  for (const viewport of [{width:768,height:1024},{width:1024,height:768}]) {
    const context = await browser.newContext({viewport,hasTouch:true});
    await context.route('**/*', route=>route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(120000);
    const errors=[];page.on('pageerror',error=>errors.push(String(error)));
    await page.setContent(`<html><head><meta charset="utf-8"><style>body{font:17px/1.65 sans-serif;margin:24px;--text-normal:#292929;--text-muted:#666;--text-accent:#248051;--background-primary:white}.callout-title{display:flex}.callout-icon{display:none}${css}</style></head><body class="theme-light an-active" data-an-palette="forest"></body></html>`);
    await page.addScriptTag({content:client});
    try {
      for (const fn of Object.keys(imports)) console.log(`WebKit ${viewport.width}:`,await page.evaluate(async fn=>{const result=await globalThis[fn]();return typeof result==='object' ? result.message : result;},fn));
      if(errors.length)throw new Error(errors.join('\n'));
      await page.evaluate(()=>{document.body.innerHTML=globalThis.academicWorkflowPreview;});
      await page.screenshot({path:`output/playwright/webkit-${viewport.width}-arrows.png`,fullPage:true});
      await page.evaluate(()=>{document.body.innerHTML=globalThis.academicReferencePreview;document.querySelector('.an-reference-popover').style.cssText='position:relative;left:0;top:0;width:440px;max-width:100%;margin:32px auto';});
      await page.screenshot({path:`output/playwright/reference-preview-${viewport.width}.png`,fullPage:true});
    } catch(error) { await page.screenshot({path:`output/playwright/webkit-${viewport.width}-failure.png`,fullPage:true});throw error; }
    finally {await context.close();}
  }
} finally {await browser.close();}
