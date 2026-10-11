import test from 'node:test';
import assert from 'node:assert/strict';
import Engine from '../src/indexing/engine';
import AcademicNotes from '../src/main';
import { DEFAULTS } from '../src/settings';
import { setLanguage } from '../src/i18n';
import { auditReferences } from '../src/workspace/audit';
import { catalogBody, readCatalog, renderCatalog, updateCatalog, type CatalogOptions } from '../src/workspace/catalog';
import { exportProfile, parseProfile, mergeProfile } from '../src/workspace/profiles';

test('reference checks distinguish ordinary anchors, duplicate IDs, excluded notes and out-of-book links', () => {
    const a = Engine.parse('a.md', 'Normal paragraph. ^normal\n\n> [!thm|1] One\n> Text\n\n^same\n\n> [!thm|1] Two\n> Text\n\n^same\n\n[[#^normal]] [[#^same]] [[missing#^x]] [[excluded#^x]] [[b#^b]] [[b#^gone]]\n\n`[[not-a-link#^x]]`');
    const b = Engine.parse('b.md', '> [!def] Good\n> Text\n\n^b');
    const graph = Engine.graph([a,b]);
    const issues = auditReferences(graph, { paths: new Set(['a.md']), book: true, resolve: name => name === 'excluded' ? 'excluded.md' : null });
    assert.deepEqual(issues.map(issue => issue.code).sort(), ['duplicate-id','number-conflict','ambiguous-block','missing-file','excluded-file','outside-book','missing-block'].sort());
    assert.equal(graph.resolve('a#^same','b.md'), null);
    assert.ok(!issues.some(issue => issue.detail.includes('normal')));
    assert.equal(issues.find(issue => issue.code === 'duplicate-id')?.related?.line, 5);
    const duplicateOrdinary = Engine.parse('ordinary.md', 'A ^x\n\nB ^x\n\n[[#^x]]');
    assert.deepEqual(auditReferences(Engine.graph([duplicateOrdinary])).map(issue=>issue.code), ['duplicate-id','ambiguous-block']);
});
test('reference checks respect numbering scopes and detect ambiguous filenames', () => {
    const note = Engine.parse('ref.md', '[[Other#^x]]\n\n## First\n\n> [!thm|1] First\n> A\n\n## Second\n\n> [!thm|1] Second\n> B');
    const graph = Engine.graph([note,Engine.parse('one/Other.md','A ^x'),Engine.parse('two/Other.md','B ^x')]);
    assert.deepEqual(auditReferences(graph).map(issue=>issue.code), ['ambiguous-file']);
});
test('Markdown catalogs are ordinary links, preserve handwriting and do not change equation numbering', () => {
    setLanguage('en');
    const a = Engine.parse('Math/a.md', '## Sets\n\n> [!thm] Compactness\n> Text\n\n^compact\n\n$$\nx+y\n$$\n\n^eq\n\n> [!lem] Without ID\n> Text');
    const graph = Engine.graph([a]);
    const options: CatalogOptions = {version:1,scope:'vault',source:'Math/a.md',types:['thm','equation','lem'],group:'type',unnumbered:true};
    const body = catalogBody(graph, options, new Set(['Math/a.md']), 'Index.md');
    assert.match(body,/\[\[Math\/a#\^compact\|Theorem 1\.1\]\]/);
    assert.match(body,/\[\[Math\/a#Sets\|Lemma 1\.1\]\]/);
    const text = '# Personal heading\n\nMy introduction.\n\n' + renderCatalog(options,body) + '\n\nMy conclusions.\n';
    assert.deepEqual(readCatalog(text),options);
    const updated = updateCatalog(text,options,'New list');
    assert.ok(updated.startsWith('# Personal heading\n\nMy introduction.\n\n')); assert.ok(updated.endsWith('\n\nMy conclusions.\n'));
    assert.throws(()=>updateCatalog('Existing user note',options,body));
    assert.throws(()=>updateCatalog(text+renderCatalog(options,body),options,body));
    const index = Engine.parse('Index.md',text);
    assert.equal(index.refs.length,0); assert.equal(index.headings.length,1);
    Engine.graph([a,index]); assert.equal(a.equations[0].number,'');
    assert.equal(catalogBody(graph,{...options,types:['equation'],unnumbered:false},new Set(['Math/a.md']),'Index.md').includes('#^eq'),false);
});
test('style profiles export an allowlist and reject arbitrary settings, CSS and invalid structure', () => {
    const settings={...DEFAULTS,exportFolder:'private/path',excludedFolders:'private/note.md',kpReading:true,customEnvironments:JSON.stringify({observation:{name:'Observation',abbr:'obs',style:'remark',numbered:true}}),
        customPalettes:JSON.stringify({'custom-ocean':{name:'Ocean',base:'sky',mode:'light'}}),lightPalette:'custom-ocean',
        paletteAppearance:JSON.stringify({'custom-ocean':{observation:{light:'#112233',motif:'laurel'}}})};
    const raw=exportProfile(settings), profile=parseProfile(raw);
    assert.ok(!raw.includes('private/')); assert.ok(!raw.includes('kpReading')); assert.ok(!raw.includes('exportFolder'));
    assert.equal(profile.settings.lightPalette,'custom-ocean');
    const bad=JSON.parse(raw); bad.settings.exportFolder='anything'; assert.throws(()=>parseProfile(JSON.stringify(bad)));
    delete bad.settings.exportFolder; bad.settings.paletteAppearance['custom-ocean'].observation.light='url(https://example.com)'; assert.throws(()=>parseProfile(JSON.stringify(bad)));
    assert.throws(()=>parseProfile(raw.replace('"version": 1','"version": 999')));
    assert.throws(()=>parseProfile(raw.replace('"observation": {','"constructor": {')));
    assert.throws(()=>parseProfile('[')); assert.throws(()=>parseProfile(' '.repeat(700001)));
});
test('style profile merge preserves unrelated preferences and resolves conflicts per environment', () => {
    const local={...DEFAULTS,exportFolder:'my-exports',kpReading:true,paletteAppearance:JSON.stringify({forest:{thm:{light:'#112233'}}})};
    const incoming={...DEFAULTS,lightPalette:'sakura',paletteAppearance:JSON.stringify({forest:{thm:{light:'#445566'},lem:{light:'#778899'}}})};
    const profile=parseProfile(exportProfile(incoming));
    const kept=mergeProfile(local,profile,false,false), replaced=mergeProfile(local,profile,true,true);
    assert.equal(JSON.parse(kept.paletteAppearance).forest.thm.light,'#112233');
    assert.equal(JSON.parse(kept.paletteAppearance).forest.lem.light,'#778899');
    assert.equal(kept.lightPalette,'forest'); assert.equal(replaced.lightPalette,'sakura');
    assert.equal(JSON.parse(replaced.paletteAppearance).forest.thm.light,'#445566');
    assert.equal(replaced.exportFolder,'my-exports'); assert.equal(replaced.kpReading,true);
    assert.equal(local.lightPalette,'forest');
});
test('large-vault indexing reuses unchanged notes, skips duplicate refreshes and handles reference renumbering', async () => {
    const previousWindow=globalThis.window; globalThis.window={setTimeout,clearTimeout} as any;
    const sources=new Map(Array.from({length:1000},(_,i)=>[`notes/${i}.md`,`> [!thm] Entry ${i}\n> Text\n\n^target`]));
    sources.set('reader.md','[[notes/0#^target]]');
    const files=[...sources.keys()].map(path=>({path,stat:{mtime:1}}));
    const cache:Record<string,any>={};
    const app:any={vault:{getMarkdownFiles:()=>files,cachedRead:async(file:any)=>sources.get(file.path)},metadataCache:{getFileCache:(file:any)=>cache[file.path]||{},getFirstLinkpathDest:(name:string)=>files.find(file=>file.path===name+'.md')},workspace:{getLeavesOfType:()=>[]}};
    const plugin=new AcademicNotes(app,{} as any); plugin.settings={...DEFAULTS};plugin.active=true;
    let refreshed=0;plugin.readers.add(()=>refreshed++);
    const refreshedByPath=new Map<string,number>();
    for(const path of ['notes/0.md','notes/1.md','reader.md']) { const reader=()=>refreshedByPath.set(path,(refreshedByPath.get(path)||0)+1);plugin.readers.add(reader);(plugin as any).readerPaths.set(reader,path); }
    try {
        await plugin.rebuild(); assert.equal(plugin.indexMetrics.parsed,1001);assert.equal(refreshed,1);
        await plugin.rebuild(); assert.equal(plugin.indexMetrics.parsed,0);assert.equal(plugin.indexMetrics.read,0);assert.equal(plugin.indexMetrics.graphRebuilt,false);assert.equal(refreshed,1);
        plugin.dirty.set('notes/0.md',true); await plugin.rebuild(); assert.equal(plugin.indexMetrics.parsed,0);assert.equal(plugin.indexMetrics.graphRebuilt,false);
        sources.set('notes/0.md','> [!thm] First\n> Text\n\n> [!thm] Entry 0\n> Text\n\n^target');files[0].stat.mtime++;
        await plugin.rebuild(); assert.equal(plugin.indexMetrics.parsed,1); assert.equal(plugin.indexMetrics.reused,1000);
        assert.equal(plugin.graph?.notes.get('reader.md')?.refs[0].target?.number,'2');
        assert.equal(refreshed,2);
        assert.equal(refreshedByPath.get('notes/0.md'),2);assert.equal(refreshedByPath.get('reader.md'),2);assert.equal(refreshedByPath.get('notes/1.md'),1);
        cache['notes/0.md']={blocks:{supplement:{position:{start:{line:0},end:{line:1}}}}};
        await plugin.rebuild(); assert.equal(plugin.indexMetrics.parsed,1);assert.ok(plugin.graph?.notes.get('notes/0.md')?.blocks.has('supplement'));
    } finally {globalThis.window=previousWindow;}
});
test('indexing retains edits arriving during an asynchronous read and awaits a fresh graph', async () => {
    const previousWindow=globalThis.window;globalThis.window={setTimeout,clearTimeout} as any;
    let source='> [!thm] Old\n> Body',first=true,release!:()=>void;
    const blocked=new Promise<void>(resolve=>{release=resolve;});
    const file={path:'race.md',stat:{mtime:1}};
    const app:any={vault:{getMarkdownFiles:()=>[file],cachedRead:async()=>{const snapshot=source;if(first){first=false;await blocked;}return snapshot;}},metadataCache:{getFileCache:()=>({}),getFirstLinkpathDest:()=>null},workspace:{getLeavesOfType:()=>[]}};
    const plugin=new AcademicNotes(app,{} as any);plugin.settings={...DEFAULTS};plugin.active=true;
    try {
        const initial=plugin.rebuild();source='> [!thm] New\n> Body';plugin.dirty.set(file.path,true);
        const fresh=plugin.rebuild();release();await Promise.all([initial,fresh]);
        assert.equal(plugin.graph?.notes.get(file.path)?.records[0].title,'New');
        assert.equal(plugin.dirty.size,0);
        assert.equal(plugin.indexTimer,undefined,'Startup events must not schedule work before layout readiness');
    }finally{globalThis.window=previousWindow;}
});
