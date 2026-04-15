# Light dbt

VS Code extension that:

- requires the `dbt` CLI to be installed
- generates a manifest artifact with `dbt parse` when missing
- watches `manifest.json` and `manifests.json` changes
- provides autocomplete for `ref()` and `source()`
- provides go-to definition for local `ref()` targets and local macros from the dbt manifest
- provides manifest-backed hover details for `ref()`, `source()`, and lineage tree nodes
- provides a manifest-backed picker that searches models, sources, seeds, snapshots, and macros and opens the selected file
- provides a lineage tree view for the active dbt model
- opens the compiled SQL for the active dbt model on demand
- can force a recompilation of the active model before opening the compiled SQL

`source()` completion is manifest-backed:

- typing the first argument suggests source table entries and can insert the full `source('source_name', 'table_name')` form
- typing the second argument after `source('source_name', '` suggests only tables for that source

`ref()` completion supports both dbt styles:

- single argument: `ref('model_name')`
- two arguments: `ref('package_name', 'model_name')`

## Get Started

If you want to use `Light dbt` in VS Code:

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Generate the installable `.vsix` package:

```bash
npm run package:vsix
```

4. In VS Code, open the Extensions view.
5. Open the Extensions `...` menu and choose `Install from VSIX...`.
6. Select the generated `light-dbt-<version>.vsix` file from the repository root.
7. Reload VS Code if prompted.
8. Open your dbt project as the workspace root.
9. Make sure `dbt --version` works in your shell.
10. Open a SQL model and use `ref(` or `source(` to trigger completions.

Main commands exposed in VS Code:

- `Light dbt: Refresh Manifest`: regenerate or reload the dbt manifest artifact so completions, model lookup, and lineage stay in sync with the project.
- `Light dbt: Refresh Lineage`: refresh the manifest-backed data and immediately rebuild the lineage tree for the active editor.
- `Light dbt: Show Lineage`: reveal the lineage view for the current active dbt model without forcing a manifest refresh first.
- `Light dbt: Show Compiled Model`: open the compiled SQL for the active model, compiling first only when the compiled artifact is missing.
- `Light dbt: Recompile and Show Model`: always run `dbt compile` for the active model and then open the freshly generated compiled SQL.
- `Light dbt: Picker`: open a quick-pick search across local manifest entities and macros, with type hints and path context, then open the selected file.

## Lineage View

The extension adds a `Lineage` tree view inside the `Light dbt` activity bar container in VS Code.

What to expect:

- the tree follows the active dbt model file in the editor
- the current model is the root item
- `Upstream` shows dependencies
- `Downstream` shows dependents
- sources can appear only as upstream leaf nodes
- local model, seed, and snapshot nodes use filled glyphs and can be opened
- external or unresolved nodes stay visible with hollow glyphs, but they do not open files
- source nodes use a distinct source glyph and open only when the manifest points to a local file
- if the lineage is truncated by the node limit, the branch ends with `… more nodes not shown`

The view is backed by dbt's manifest graph, but rendered as a normal VS Code tree. Shared dependencies can therefore appear more than once in different branches.

## Requirements

- `dbt` must be installed and available on your `PATH`
- a dbt project must be opened as the VS Code workspace root
- Node.js 25+ and npm are required for local development

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Build the extension:

```bash
npm run build
```

3. Rebuild automatically while editing, if needed:

```bash
npm run watch
```

4. Open this repository in VS Code.
5. Press `F5` and choose `Run dbt Auto Complete`.
6. A new Extension Development Host window will open with the extension loaded.

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

- `Light dbt: Refresh Manifest`
- `Light dbt: Refresh Lineage`
- `Light dbt: Show Lineage`
- `Light dbt: Show Compiled Model`
- `Light dbt: Recompile and Show Model`
- `Light dbt: Picker`

What each command does:

- `Light dbt: Refresh Manifest` checks `dbt`, regenerates or reloads the manifest, and refreshes manifest-backed features
- `Light dbt: Refresh Lineage` refreshes the manifest and then rebuilds lineage for the active editor
- `Light dbt: Show Lineage` reveals lineage for the active editor without forcing a manifest refresh first
- `Light dbt: Show Compiled Model` opens compiled SQL for the active model, compiling first only if needed
- `Light dbt: Recompile and Show Model` always recompiles the active model before opening compiled SQL
- `Light dbt: Picker` opens the manifest-backed quick-pick search and does not refresh lineage by itself

The picker command is also manifest-backed:

- it searches local models, sources, seeds, snapshots, and macros from the current manifest
- each result shows a type hint such as `model`, `source`, or `macro`
- the detail line includes package, fully qualified name, and original manifest path when available
- selecting a result opens the local file directly

Go-to definition is also manifest-backed:

- placing the cursor on the model argument in `ref('model_name')` or `ref('package_name', 'model_name')` opens the local model, seed, or snapshot file when it exists in the workspace
- placing the cursor on a macro call like `my_macro(...)` or `package_name.my_macro(...)` opens the local macro file when it exists in the workspace
- if multiple local matches exist, VS Code shows the normal multi-definition picker

Hover details are also manifest-backed:

- tooltips appear when hovering the string argument for `ref('model_name')`
- tooltips appear when hovering either string argument for `ref('package_name', 'model_name')`
- tooltips appear when hovering either string argument for `source('source_name', 'table_name')`
- tooltips appear when hovering a macro call identifier such as `my_macro(...)` or `package_name.my_macro(...)`
- tooltips appear when hovering any node in the lineage tree, including the root model, upstream nodes, downstream nodes, and source leaf nodes
- hovering a resolved `ref()` target shows package, resource type, file, fully qualified name, immediate parents, immediate children, and directly referenced macros
- hovering a resolved `source()` target shows the same metadata for the selected source table
- hovering a resolved macro call shows package, file, fully qualified name, and unique ID for the macro
- hovering a lineage tree node shows the same metadata used by editor hovers, plus the lineage direction shown in the tree

For the compiled-model command:

- the active editor must be a local dbt model represented in the manifest
- if the compiled SQL already exists under `target/compiled/<package>/...`, the extension opens it immediately
- otherwise the extension runs `dbt compile --select path:<model_path>` and then opens the generated compiled SQL

For the recompile command:

- the extension always runs `dbt compile --select path:<model_path>` for the active model
- after the compile finishes, it opens the compiled SQL from `target/compiled/<package>/...`
- compile progress is shown both as a VS Code progress notification and a temporary status bar message

### 3. Verify manifest generation

Delete `target/manifest.json` if it already exists, then run:

- `Light dbt: Refresh Manifest`

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

- VS Code suggests source table entries from the manifest
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

### 7. Verify go-to definition

Open a SQL or Jinja SQL file and use VS Code's normal `Go to Definition` action on:

- the model argument inside `ref('some_model')`
- the model argument inside `ref('some_package', 'some_model')`
- a macro call such as `my_macro(...)`
- a package-qualified macro call such as `dbt_utils.star(...)`

Expected result:

- local `ref()` targets open the corresponding model, seed, or snapshot file
- local macros open the corresponding macro file
- unresolved or external-only targets do not open anything

### 8. Verify picker search

Run:

- `Light dbt: Picker`

Expected result:

- VS Code opens a quick-pick that searches across manifest-backed models, sources, seeds, snapshots, and macros
- items show a type hint in the description field
- items show package and path context in the detail field when available
- selecting an item opens the matching local file

### 9. Verify the lineage tree

Open a dbt model file that exists in the manifest.

Expected result:

- the `Lineage` view shows the current model as the root item
- the view shows `Upstream` and `Downstream` branches
- expanding a local model node opens further lineage within the configured limits
- clicking a local model, seed, or snapshot node opens the corresponding file
- clicking a local source node opens its YAML file when the manifest points to one in the workspace
- unresolved or external nodes stay visible but do not open a file
- hovering any lineage node shows package, kind, file, FQN, immediate parents, immediate children, and macros

### 10. Verify hover details

Open a SQL or Jinja SQL file and hover:

- the model argument inside `ref('some_model')`
- either argument inside `ref('some_package', 'some_model')`
- either argument inside `source('some_source', 'some_table')`
- a macro call such as `my_macro(...)`
- a package-qualified macro call such as `dbt_utils.star(...)`

Expected result:

- the hover is resolved from the manifest
- the tooltip appears only when hovering supported `ref()` and `source()` string arguments, macro call identifiers, or lineage tree nodes
- the hover shows package, resource type, file, and fully qualified name when available
- the hover lists immediate parents, immediate children, and direct macro dependencies
- if an unscoped `ref()` name exists in multiple packages, the hover shows one section per matching target

If you open a file that is not a dbt model represented in the manifest, the lineage view should show an empty-state message instead of stale lineage.

### 11. Verify lineage limits

Add settings like:

```json
"dbtAutoComplete.lineage.maxNodes": 30
```

Expected result:

- the tree keeps traversing lineage until it exhausts the node budget
- total lineage nodes are capped across both branches
- when a limit is hit, the branch shows `… more nodes not shown`
- changing these settings rebuilds the tree without restarting VS Code

### 12. Verify compiled model output

Open a dbt model file that exists in the manifest, then run:

- `Light dbt: Show Compiled Model`
- `Light dbt: Recompile and Show Model`

Expected result:

- `Show Compiled Model` opens the existing compiled SQL immediately when present, otherwise it compiles the active model first
- `Recompile and Show Model` always recompiles the active model before opening the compiled SQL
- during compilation, VS Code shows progress in a notification and in the status bar
- if the active file is not a manifest-backed dbt model, the extension shows a warning instead of opening an unrelated file

## Commands

- `Light dbt: Refresh Manifest`: regenerate or reload the dbt manifest artifact
- `Light dbt: Refresh Lineage`: refresh manifest-backed lineage data and rebuild the tree
- `Light dbt: Show Lineage`: reveal lineage for the current active dbt model
- `Light dbt: Show Compiled Model`: open the compiled SQL for the active model, compiling only if the compiled artifact is missing
- `Light dbt: Recompile and Show Model`: force `dbt compile` for the active model and then open the compiled SQL from `target/compiled/...`
- `Light dbt: Picker`: search local manifest-backed models, sources, seeds, snapshots, and macros, then open the selected file

## Development Scripts

- `npm run build`: compile the TypeScript extension into `dist/`
- `npm run watch`: run the TypeScript compiler in watch mode during local development
- `npm run package:vsix`: build a `.vsix` package for installation or distribution

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

- a file like `light-dbt-0.0.1.vsix` is created in the repository root

Recommended packaging flow:

1. Install dependencies with `npm install`.
2. Build the extension with `npm run build`.
3. Generate the package with `npm run package:vsix`.
4. Share the generated `.vsix` file with users.

To distribute this to non-developers, package it as a `.vsix` and share that file or publish it to the VS Code Marketplace.

## Notes

The extension assumes a dbt project lives at the workspace root and uses `target/manifest.json` by default. A custom manifest path can be configured with `dbtAutoComplete.manifestRelativePath`.
