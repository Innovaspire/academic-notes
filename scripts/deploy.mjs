import { readFile, writeFile, mkdir, lstat, realpath, rename, rm, copyFile } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assets = ['main.js', 'manifest.json', 'styles.css'];
async function stat(path) { try { return await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
const inside = (parent, child) => { const rel = relative(parent, child); return !rel || !rel.startsWith('..') && !isAbsolute(rel); };
function run(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true, shell: false, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} exited with ${result.status}`);
}
/** Copy only the release assets; rollback a failed write and retain the previous assets outside the vault. */
export async function deployFiles(source, vault, configDir = '.obsidian') {
  const root = await realpath(source), vaultRoot = await realpath(vault);
  if (!/^\.[A-Za-z0-9_-]+$/.test(configDir)) throw new Error('config-dir must be one hidden folder name, such as .obsidian.');
  if (inside(vaultRoot, root)) throw new Error('Keep the development project outside the target vault.');
  const config = join(vaultRoot, configDir);
  if (!(await stat(config))?.isDirectory() || (await stat(config)).isSymbolicLink()) throw new Error('Target must contain a real Obsidian configuration folder.');
  const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
  if (manifest.id !== 'academic-notes' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Unexpected plugin manifest.');
  const contents = new Map(await Promise.all(assets.map(async name => [name, await readFile(join(root, name))])));
  const plugins = join(config, 'plugins'), target = join(plugins, manifest.id);
  for (const path of [plugins, target, ...assets.map(name => join(target, name))]) {
    if ((await stat(path))?.isSymbolicLink()) throw new Error(`Refusing a linked deployment path: ${path}`);
  }
  const previous = new Map();
  for (const name of assets) if (await stat(join(target, name))) previous.set(name, await readFile(join(target, name)));
  if (previous.has('manifest.json') && JSON.parse(previous.get('manifest.json').toString()).id !== manifest.id) throw new Error('Target contains another plugin.');
  const backup = join(root, 'output', 'deploy-backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID());
  await mkdir(backup, { recursive: true });
  for (const [name, bytes] of previous) await writeFile(join(backup, name), bytes);
  await mkdir(target, { recursive: true });
  const written = [], temporary = [];
  try {
    for (const name of assets) {
      const temp = join(target, `.${name}.${randomUUID()}.tmp`); temporary.push(temp);
      await writeFile(temp, contents.get(name), { flag: 'wx' });
      await rename(temp, join(target, name)); written.push(name);
    }
  } catch (error) {
    for (const name of written.reverse()) {
      if (previous.has(name)) await copyFile(join(backup, name), join(target, name));
      else await rm(join(target, name), { force: true });
    }
    throw error;
  } finally { for (const path of temporary) await rm(path, { force: true }); }
  return { target, vault: vaultRoot, version: manifest.version, backup };
}
async function main() {
  const { values } = parseArgs({ options: {
    vault: { type: 'string' }, 'config-dir': { type: 'string', default: '.obsidian' },
    'skip-build': { type: 'boolean', default: false }, 'no-reload': { type: 'boolean', default: false },
    obsidian: { type: 'string' }, help: { type: 'boolean' }
  } });
  if (values.help || !values.vault && !process.env.ACADEMIC_NOTES_VAULT) {
    console.log('npm run deploy -- --vault "path/to/test-vault" [--obsidian "path/to/Obsidian.com"] [--no-reload]');
    console.log('Or set ACADEMIC_NOTES_VAULT. Build and deploy touch only main.js, manifest.json and styles.css.');
    if (!values.help) process.exitCode = 1;
    return;
  }
  if (!values['skip-build']) {
    run(process.execPath, [join(project, 'node_modules/typescript/bin/tsc'), '--noEmit'], project);
    run(process.execPath, [join(project, 'esbuild.config.mjs')], project);
  }
  const result = await deployFiles(project, values.vault || process.env.ACADEMIC_NOTES_VAULT, values['config-dir']);
  console.log(`Deployed ${result.version} to ${result.target}\nPrevious assets: ${result.backup}`);
  if (!values['no-reload']) {
    const windowsCli = process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs/Obsidian/Obsidian.com');
    const executable = values.obsidian || process.env.OBSIDIAN_CLI || (windowsCli && await stat(windowsCli) ? windowsCli : 'obsidian');
    try { run(executable, ['plugin:reload', 'id=academic-notes'], result.vault); }
    catch (error) { console.error(`Files deployed; automatic reload failed. Open this vault and reload Academic Notes manually. ${error.message}`); process.exitCode = 1; }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
