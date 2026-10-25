import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deployFiles } from '../scripts/deploy.mjs';
test('deployment copies only three assets and preserves settings, unrelated files and backups',async()=>{
 const root=await mkdtemp(join(tmpdir(),'academic-deploy-'));
 try{
  const source=join(root,'source'),vault=join(root,'vault'),target=join(vault,'.obsidian','plugins','academic-notes');
  await mkdir(source,{recursive:true});await mkdir(target,{recursive:true});
  await writeFile(join(source,'manifest.json'),JSON.stringify({id:'academic-notes',version:'2.15.4'}));
  await writeFile(join(source,'main.js'),'new');await writeFile(join(source,'styles.css'),'new css');
  await writeFile(join(source,'private.txt'),'never deploy');await writeFile(join(target,'main.js'),'old');await writeFile(join(target,'data.json'),'settings');
  const result=await deployFiles(source,vault);
  assert.deepEqual((await readdir(target)).sort(),['data.json','main.js','manifest.json','styles.css']);
  assert.equal(await readFile(join(target,'data.json'),'utf8'),'settings');assert.equal(await readFile(join(result.backup,'main.js'),'utf8'),'old');
  assert.equal(await readFile(join(target,'main.js'),'utf8'),'new');
  await assert.rejects(deployFiles(source,vault,'../escape'));
  await assert.rejects(deployFiles(source,source));
 }finally{await rm(root,{recursive:true,force:true});}
});
