# Browsable DyLean

A mobile-friendly, fully static browser for the Lean code in `../dylean`.

**Open `dist/index.html` directly**, or serve `dist/` with any static web server. The generated snapshot is included. No backend, API, CDN, build tools, or Lean installation is required to browse it.

## Generate a fresh static website

Requires Python 3.9+ and [elan / Lake](https://github.com/leanprover/elan) on your PATH. Lake uses the source repository's pinned Lean toolchain. There are no Python packages or frontend runtime dependencies to install.

```sh
cd ../browsable-dylean
python3 scripts/build.py
# Equivalent: npm run build
```

The generator runs `lake build` and explicitly builds every repository module's `.ilean` index, then writes the complete website to `dist/`. A Lean build failure stops the export. It doesn't edit Lean source files, but Lake updates the source repo's ignored `.lake` build cache.

Options:

```sh
python3 scripts/build.py --source /path/to/dylean --out /path/to/site
python3 scripts/build.py --skip-lean  # reuse existing indexes; rejects missing or older indexes
```

`--skip-lean` is a local speed shortcut with timestamp-based freshness checks. Use the default build for authoritative regeneration after source or toolchain changes. Build output records the source commit, content hash, and pinned toolchain in `dist/build-info.json`.

## Preview and publish

```sh
python3 -m http.server 4173 --directory dist
# Equivalent: npm run preview
```

Open <http://localhost:4173>. To preview on a phone on the same network, open `http://<your-computer-LAN-IP>:4173`; the preview command listens on all interfaces.

Upload **the contents of `dist/`** to any static host, including GitHub Pages, Netlify, Cloudflare Pages, or an ordinary web server. For a GitHub Pages branch deployment, copy those contents to the selected publishing directory. No SPA rewrites or server functions are needed. Asset paths are relative and routes use URL fragments, so subdirectory hosting and shared deep links work. HTTP compression on the host will further reduce the index transfer size.

The checked-in snapshot can be hosted immediately. To regenerate on a build service, provide the DyLean checkout and the pinned Lean toolchain, run the generator, and publish `dist/`.

## Navigation

- Tap a linked identifier to go to its resolved definition. Ambiguous source ranges offer a choice.
- Use the toolbar's Back / Forward or native browser history to return to your reading position.
- Tap line numbers to create links to exact source locations; Copy link shares the current view.
- Inspect **Callers**, **Callees**, and **References**. Expand branches to explore recursively; cycles are marked and stop expanding.
- Explore module imports and reverse imports in **Imports**.
- Search symbols, files, or source text. `/` opens search; Escape closes it.
- Use the file outline to jump between declarations, and Raw to download a source file.
- On mobile, switch between **Files**, **Code**, and **Inspect** in the fixed bottom bar. Long lines wrap by default; wrapping can be toggled. Controls are keyboard-accessible, dialogs retain native keyboard behavior, and tab groups support arrow keys.

## Accuracy and scope

The index is built from **Lean compiler `.ilean` metadata (format version 5)**, not textual name matching. Definition positions and usage locations are zero-based UTF-16 internally, matching Lean's LSP data. The UI shows one-based line numbers.

In Lean, the caller graph is a **declaration dependency graph**: an edge means a declaration contains a resolved source reference to another declaration. Uses in types, proofs, and function implementations all count. It is not a runtime execution trace, and dependencies without compiler-recorded source references may be absent. References outside a declaration (for example, some attributes) appear in References without a caller edge.

The exported scope is all non-hidden `.lean` files in DyLean. Constructors and structure fields with compiler definition records are included. Generated declarations remain in the graph but are hidden from ordinary symbol search and outlines. Lean / Std toolchain definitions and local-variable bindings are not bundled or linked. Existing source license terms are copied to `dist/SOURCE-LICENSE.txt`.

Everything runs in the browser, including the search and hierarchy views. No network requests are required after the static assets load. Local storage is used only for the line-wrap preference.

## Develop and verify

Edit `web/index.html`, `web/style.css`, and `web/app.js`; edit `scripts/build.py` for indexing changes. Regenerate `dist/` after editing. The generated directory is intentionally tracked so the repository is also a ready-to-host artifact.

```sh
npm ci       # installs jsdom for tests only; Node 22.13+ recommended
npm test
```

Tests validate source coverage, UTF-16 target ranges, cross-file references, graph consistency, relative assets, and DOM-level navigation behavior. They exercise definition jumps, Back/Forward with scroll restoration, hierarchy expansion, mobile view switching, search, and faithful rendering of every source file. These are automated index and DOM tests, not screenshots or testing on physical phones.
