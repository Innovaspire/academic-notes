# Release and submission

Keep the English and Chinese READMEs focused on project features. Detailed user documentation lives in the [Wiki](https://github.com/Kristal-Boltinn/academic-notes/wiki), with a [Chinese guide](https://github.com/Kristal-Boltinn/academic-notes/wiki/Home-ZH). Update the matching Wiki pages when behavior changes; its separate Git repository is `https://github.com/Kristal-Boltinn/academic-notes.wiki.git`.

1. Confirm the public author identity and the unique `academic-notes` ID / Academic Notes name in the Community Directory. The generic contributors author is intentional until a public identity is chosen.
2. Run `npm ci`, `npm run lint`, `npm test`, `npm run build`, `npm run test:electron`, `npm run check:release`. On Linux the Electron test requires a display (CI uses `xvfb-run`).
3. Install only the three built release files into a test vault as `academic-notes`. Verify plugin enable/disable, source vs Live Preview, scrolling/nesting, references, theme switches, single-note PDF and a multi-note book, including long formulas, fonts and images.
4. Update version metadata and CHANGELOG. Commit source and package-lock.json. Never commit data.json, node_modules, output/, a real vault, local executable paths or personal test documents.
5. Push the version tag without a `v` prefix. The workflow rejects mismatches and creates a draft GitHub Release with main.js, manifest.json and styles.css. The build job generates GitHub artifact attestations for all three files. Inspect its assets and attestations, then publish manually. Verify downloaded assets with `gh attestation verify main.js -R Kristal-Boltinn/academic-notes` (repeat for styles.css and manifest.json). A workflow edit alone does not attest an existing release.
6. Sign in to the Obsidian Community Directory, link the repository, run its available review/preview scan, resolve actual findings, and submit. Local checks do not predict approval.

References verified 2026-09-20:

- [Developer policies](https://docs.obsidian.md/community-directory/developer-policies)
- [Submit your plugin](https://docs.obsidian.md/plugins/releasing/submit-plugin)
- [Manifest requirements](https://docs.obsidian.md/Reference/Manifest)

This repository's automation does not create a repository, publish a public release or submit to the Community Directory by itself.

## Develop outside the vault

Keep this Git checkout, dependencies and output outside any daily-note vault. After `npm ci`, build and install into a test vault with:

```sh
npm run deploy -- --vault "path/to/test-vault"
```

The vault must already contain `.obsidian/` (or use `--config-dir .obsidian-dev`). Only `main.js`, `manifest.json` and `styles.css` go into `.obsidian/plugins/academic-notes/`. Settings, notes and other plugins are preserved. Previous assets are backed up under this checkout's `output/deploy-backups/`; a failed file write rolls back the completed writes.

The command reloads the plugin with Obsidian CLI from the target vault directory. Obsidian must be running with that vault open and CLI enabled; a newly installed plugin may need enabling first. Set `--obsidian "path/to/Obsidian.com"` or `OBSIDIAN_CLI` if the CLI is not found. `--no-reload` installs without invoking the CLI; a reload failure leaves the new assets installed and reports this explicitly. See [official CLI setup](https://help.obsidian.md/cli).

Set `ACADEMIC_NOTES_VAULT` locally to avoid repeating `--vault`. Use `--skip-build` only to deploy assets that have already been built. The development script uses Node filesystem/process APIs; it is not part of the installed plugin and is not bundled in `main.js`.
