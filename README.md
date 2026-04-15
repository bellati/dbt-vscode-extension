# dbt Auto Complete

VS Code extension that:

- requires the `dbt` CLI to be installed
- generates a manifest artifact with `dbt parse` when missing
- watches `manifest.json` and `manifests.json` changes
- provides autocomplete for `ref()` and `source()`
- provides a lineage tree view for the active dbt model
- opens the compiled SQL for the active dbt model on demand

`source()` completion is two-level:

- first argument: source name
- second argument: table name

`ref()` completion supports both dbt styles:

- single argument: `ref('model_name')`
- two arguments: `ref('package_name', 'model_name')`

## Lineage View

The extension adds a `Lineage` tree view inside the `dbt Auto Complete` activity bar container in VS Code.

What to expect:

- the tree follows the active dbt model file in the editor
- the current model is the root item
- `Upstream` shows dependencies
- `Downstream` shows dependents
- sources can appear only as upstream leaf nodes
- local nodes use a green icon and can be opened
- external or unresolved nodes use a gray icon and are shown for visibility, but they do not open files
- if the lineage is truncated by the node limit, the branch ends with `… more nodes not shown`

The view is backed by dbt's manifest graph, but rendered as a normal VS Code tree. Shared dependencies can therefore appear more than once in different branches.

## Requirements

- `dbt` must be installed and available on your `PATH`
- a dbt project must be opened as the VS Code workspace root
- Node.js 25+ and npm are required for local development

## Installation

### For normal users

This extension is not published to the VS Code Marketplace yet. The intended installation method is a packaged `.vsix` file.

Once you have a `.vsix` file:

1. Open VS Code.
2. Open the Extensions view.
3. Click the `...` menu in the top-right of the Extensions panel.
4. Choose `Install from VSIX...`.
5. Select the `.vsix` file for `dbt Auto Complete`.
6. Reload VS Code if prompted.

After installation:

1. Open your dbt project as the workspace root.
2. Make sure `dbt --version` works in your shell.
3. Open a SQL model and use `ref(` or `source(` to trigger completions.
4. Open the `dbt Auto Complete` activity bar container to inspect lineage for the active model.

### If you only have the source repository

End users should not install directly from the source tree. Ask the maintainer for a packaged `.vsix` file, or for a Marketplace publication once the extension is released there.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Open this repository in VS Code.
4. Press `F5` and choose `Run dbt Auto Complete`.
5. A new Extension Development Host window will open with the extension loaded.

## How To Test

### 1. Prepare a dbt project

Open a real dbt project in the Extension Development Host window. The extension expects the dbt project at the workspace root.

If you want to test against a specific manifest path, set:

```json
"dbtAutoComplete.manifestRelativePath": "target/manifest.json"
```

in the workspace settings.

### 2. Verify dbt detection

When the extension activates:

- if `dbt` is missing from `PATH`, the extension shows an error
- if `dbt` is available, the status bar shows the extension state

You can also run the command palette action:

- `dbt Auto Complete: Refresh Manifest`
- `dbt Auto Complete: Refresh Lineage`
- `dbt Auto Complete: Show Lineage`
- `dbt Auto Complete: Show Compiled Model`

These commands force the extension to check `dbt` again, reload the manifest, and reveal the lineage tree for the active model.

For the compiled-model command:

- the active editor must be a local dbt model represented in the manifest
- the extension runs `dbt compile --select path:<model_path>`
- the compiled SQL opens from `target/compiled/<package>/...`

### 3. Verify manifest generation

Delete `target/manifest.json` if it already exists, then run:

- `dbt Auto Complete: Refresh Manifest`

Expected result:

- the extension runs `dbt parse`
- `target/manifest.json` is created if parsing succeeds
- the status bar updates to show the number of refs and sources loaded

The extension also accepts `target/manifests.json` if your workflow produces that filename instead.

### 4. Verify autocomplete for `ref()`

Open a SQL model file and type:

```sql
select * from {{ ref('
```

Expected result:

- VS Code suggests model names from `manifest.json`
- VS Code also suggests package names for cross-project refs
- selecting a model with a known package inserts the full form, for example `ref('data_platform', 'ontology_entitized_jobs_title')`
- inserted completions preserve the quote style you started with, so `ref("` yields double-quoted insertions
- if you backspace while editing the current ref text, suggestions should reopen and keep filtering instead of disappearing

If you choose a package suggestion, it inserts the first argument and places the cursor inside the second argument:

```sql
select * from {{ ref('data_platform', '
```

Expected result:

- VS Code suggests only refs available in `data_platform`

### 5. Verify autocomplete for `source()`

Type:

```sql
select * from {{ source('
```

Expected result:

- VS Code suggests available source table names
- inserted completions preserve whether you typed `'` or `"`
- selecting a table inserts the full form, for example `source('jaffle_shop', 'customers')`
- if you backspace while editing the current source text, suggestions should reopen automatically

Then continue with:

```sql
select * from {{ source('my_source', '
```

Expected result:

- VS Code suggests the tables for `my_source`

### 6. Verify live reload

Regenerate the manifest from your dbt project:

```bash
dbt parse
```

Expected result:

- the extension detects the manifest file change
- completion results update without restarting VS Code
- the lineage tree updates without restarting VS Code

### 7. Verify the lineage tree

Open a dbt model file that exists in the manifest.

Expected result:

- the `Lineage` view shows the current model as the root item
- the view shows `Upstream` and `Downstream` branches
- expanding a local model node opens further lineage within the configured limits
- clicking a local model, seed, or snapshot node opens the corresponding file
- clicking a local source node opens its YAML file when the manifest points to one in the workspace
- gray nodes stay visible but do not open a file

If you open a file that is not a dbt model represented in the manifest, the lineage view should show an empty-state message instead of stale lineage.

### 8. Verify lineage limits

Add settings like:

```json
"dbtAutoComplete.lineage.maxNodes": 30
```

Expected result:

- the tree keeps traversing lineage until it exhausts the node budget
- total lineage nodes are capped across both branches
- when a limit is hit, the branch shows `… more nodes not shown`
- changing these settings rebuilds the tree without restarting VS Code

### 9. Verify compiled model output

Open a dbt model file that exists in the manifest, then run:

- `dbt Auto Complete: Show Compiled Model`

Expected result:

- the extension runs `dbt compile` for the active model
- VS Code opens the compiled SQL file from `target/compiled/...`
- if the active file is not a manifest-backed dbt model, the extension shows a warning instead of opening an unrelated file

## Commands

- `dbt Auto Complete: Refresh Manifest`: regenerate or reload the dbt manifest artifact
- `dbt Auto Complete: Show Lineage`: reveal lineage for the current active dbt model
- `dbt Auto Complete: Refresh Lineage`: refresh manifest-backed lineage data and rebuild the tree
- `dbt Auto Complete: Show Compiled Model`: run `dbt compile` for the active model and open the compiled SQL from `target/compiled/...`

## Configuration

- `dbtAutoComplete.manifestRelativePath`: relative path from the workspace root to the manifest artifact
- `dbtAutoComplete.lineage.maxNodes`: maximum total number of lineage nodes to materialize across both branches

## Troubleshooting

- If you do not see completions, make sure the file is recognized as `sql` or `jinja-sql`.
- If you do not see lineage, make sure the active file is a dbt model represented in the manifest.
- If manifest generation fails, run `dbt parse` manually in the dbt project root to confirm the project is valid.
- If `dbt` is installed but not found, start VS Code from a shell where `dbt --version` works, or ensure the binary is on your GUI environment `PATH`.
- If your manifest is not in `target/manifest.json`, set `dbtAutoComplete.manifestRelativePath` to the correct relative path.

## Packaging Notes

The compiled extension entrypoint is generated at `dist/extension.js` by:

```bash
npm run build
```

To generate a `.vsix` package from this repository:

```bash
npm run package:vsix
```

This runs:

```bash
npx @vscode/vsce package
```

Expected result:

- a file like `dbt-auto-complete-0.0.1.vsix` is created in the repository root

Recommended packaging flow:

1. Install dependencies with `npm install`.
2. Build the extension with `npm run build`.
3. Generate the package with `npm run package:vsix`.
4. Share the generated `.vsix` file with users.

To distribute this to non-developers, package it as a `.vsix` and share that file or publish it to the VS Code Marketplace.

## Notes

The extension assumes a dbt project lives at the workspace root and uses `target/manifest.json` by default. A custom manifest path can be configured with `dbtAutoComplete.manifestRelativePath`.
