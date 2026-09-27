# browser-moonscript

Run **MoonScript entirely in the browser** — no compile server, no upload, no install.

This is a proof of concept for adding MoonScript to [LiveCodes](https://livecodes.io), in the same
spirit as [`browser-clojurescript`](https://github.com/live-codes/browser-clojurescript) and
[`browser-ocaml`](https://github.com/live-codes/browser-ocaml) were for their languages. Type
MoonScript, press **Run**, and it compiles and executes in the tab.

**LiveCodes itself is untouched.** Nothing here modifies or imports the LiveCodes repo; this is a
standalone browser component, and the notes on wiring it in are just that.

## Run it

```bash
node server.mjs        # -> http://localhost:8131/
```

A static server is required, because the page is an ES module that loads a WebAssembly compiler and
`file://` allows neither. `server.mjs` serves files and does no computation — nothing is compiled,
uploaded or fetched on the user's behalf. Any static host works.

## How it works

MoonScript compiles to Lua, so "run MoonScript in the browser" is really two jobs: **compile
MoonScript → Lua**, then **run that Lua**. Both happen client-side, using **two different runtimes**:

```
MoonScript source
      │  moonscript.js
      ▼
leafo/moonscript-javascript            MoonScript 0.8.0 + Lua 5.5.1 + LPeg 1.1.0
      │  525 KB WebAssembly            compiled to wasm with Emscripten.
      │                                Powers moonscript.org/compiler.
      ▼
Lua source            ← also shown in the page's "Compiled Lua" panel
      │
      ▼
Fengari                                Lua 5.3.4 in JavaScript. The runtime
      │  215 KB                       LiveCodes already uses for `lua`.
      ▼
program output
```

### Why the compiler has to be WebAssembly

The real MoonScript parser is built on **LPeg**, a C extension. There is no pure-Lua LPeg and no JS
port, so there is no way to run `moonscript.lua` under Fengari — which is why the other compile-to-Lua
languages in LiveCodes (Fennel, Teal) are not a pattern that can simply be copied here. leafo's
Emscripten build embeds Lua, LPeg and the compiler together, and is the only route to the genuine
parser rather than a reimplementation.

### Why the *execution* is Fengari and not the wasm

leafo's wasm can also *run* MoonScript (`run_moonscript`), and using it for both steps would mean one
artifact instead of two. It is deliberately not used for that here, because a wasm Lua VM has no
connection to the page: MoonScript code could not touch the DOM at all.

Running the compiled Lua on Fengari instead means `require "js"` works — the same interop that makes
`lua` and `fennel` in LiveCodes real browser languages. The five examples include one that writes to
the page to show it. It also makes this the shape LiveCodes needs (see
[Fitting LiveCodes](#fitting-livecodes)): compile to Lua, then hand the Lua to the runtime that
already exists.

## What is verified

Driven end to end in headless Chrome, against the running page:

| | Result |
| --- | --- |
| Hello & string interpolation | `Hello from MoonScript!` / `2 + 2 = 4` |
| Functions & recursion | `1! = 1` … `10! = 3628800` |
| Tables & comprehensions | `squares: 1, 4, 9, 16, 25, 36`, `total: 21` |
| Classes & inheritance | `circle has area 12.56636`, `square has area 9` |
| `require "js"` DOM interop | wrote into the page's DOM target |
| Compile error | `failed to parse at line 1, column 5:` with a caret at the offending token |
| Runtime error | `one` printed, then `moon:2: kaboom`, status "Runtime error" |
| Run time | 28 ms cold, 4 ms warm |
| Browser console | clean — no CORS, MIME or wasm warnings |

The reported versions are read out of the wasm at runtime rather than assumed. Worth doing: the
upstream repository's README says the build contains Lua 5.3.6, and it actually contains **Lua
5.5.1** and **MoonScript 0.8.0**.

## Two Lua versions, on purpose but worth knowing

The compiler is **Lua 5.5.1**; the runtime that executes its output is **Lua 5.3.4**. Generated
MoonScript code is plain Lua and does not use version-specific syntax, so this has not caused a
problem in any of the examples — but it is a real seam, not a detail. If a program's behaviour
depends on Lua version differences (integer/float edges, `math` changes between 5.3 and 5.5), the
two halves will disagree.

The obvious alternative is to run the output on **wasmoon** (Lua 5.4) — the runtime LiveCodes uses
for `lua-wasm` — which narrows the gap and is a one-function change here. The trade-off is that
`wasmoon` interop is the `lua.global.set('window', window)` style rather than Fengari's `js` module,
and `lua` in LiveCodes is Fengari. Neither is wrong; it is a choice worth making deliberately during
integration rather than by accident.

## The compiler API cannot report errors

Worth knowing before touching this, because it is the least obvious thing in the code.

`compile_moonscript` returns **the compiled Lua and the error message in the same return slot**, with
no way to tell them apart. Its own C source says so:

```c
// this will return either:
// 1. compiled code
// 2. exception error
// 3. compile error
// We currently make no destinction between compiled code an an error :(
```

So `run()` does not guess. It hands whatever came back to a **Lua parser**: if it loads, it was code;
if it does not, it was an error message, and the message itself is what gets shown. That is exact
rather than heuristic — a MoonScript parse error (`failed to parse at line 1, column 5: …`) is not
valid Lua — and it costs one parse. The page reports `Compile error` or `Runtime error` accordingly.

A second trap, found while writing this: **`run_moonscript` compiles its input as MoonScript, not
Lua.** `versions()` probes look like Lua only because `return require('x').y` happens to parse as
both languages; anything longer is not valid MoonScript and fails.

## Payload

| Asset | Raw | Gzip | Brotli |
| --- | --- | --- | --- |
| `moonscript.wasm` (compiler + Lua + LPeg) | 525 KB | 164 KB | 137 KB |
| `moonscript.js` (Emscripten glue) | 7.7 KB | 3.4 KB | 3.0 KB |
| `fengari-web.js` (Lua runtime) | 215 KB | 68 KB | 59 KB |
| **total** | **~748 KB** | **~236 KB** | **~199 KB** |

All of it is fetched lazily and from a CDN; the page itself is ~15 KB. For comparison, the
ClojureScript and OCaml spikes are 8.1 MB and 4.2 MB. All four dependencies (MoonScript, Lua, LPeg,
Fengari) are permissively licensed, so unlike the bash spike there is no copyleft question to reason
about.

## Fitting LiveCodes

The module is shaped like a `LanguageSpecs` entry on purpose. The target is the same shape `fennel`
and `teal` already use — a compiler that produces Lua, and `scriptType: 'application/lua'` so the
existing Lua runtime runs it:

```ts
export const moonscript: LanguageSpecs = {
  name: 'moonscript',
  title: 'MoonScript',
  compiler: {
    factory: (_config, baseUrl) => {
      (self as any).importScripts(baseUrl + '{{hash:lang-moonscript-compiler.js}}');
      return (self as any).createMoonScriptCompiler();
    },
    scriptType: 'application/lua',
    compiledCodeLanguage: 'lua',
  },
  extensions: ['moon'],
  editor: 'script',
};
```

Three things stand between this PoC and that entry:

1. **The wasm has to live in `browser-compilers`.** Its `dist/` already vendors a `fennel/` directory
   for exactly this reason; MoonScript needs a `moonscript/` one holding the glue and the `.wasm`.
   Pinned to `leafo/moonscript-javascript@0cc6cf1` (the commit that made the wasm cross-origin
   loadable, which is what allows a CDN in the first place).
2. **Loading it from a compiler worker is the open question.** LiveCodes compiler factories load
   their scripts with `importScripts`, but this glue is an **ES module**. It needs either a
   dynamic `import()` inside the worker or a non-module bundle of the glue. This is the first thing
   to prove, and it is the main reason this is a spike rather than a patch.
3. **Decide Fengari vs wasmoon** for the run step (see [above](#two-lua-versions-on-purpose-but-worth-knowing)).

Also worth carrying over: LiveCodes' `lua-wasm` language pins a wasm toolchain and flags it as a large
download. MoonScript is far smaller than that, but the wasm still wants aggressive caching.

## Limitations

- **A runaway program hangs the page.** Execution is on the main thread and a `while true` cannot be
  interrupted. LiveCodes runs a language's result in its own frame, which is what makes teardown
  possible — this belongs there, not here.
- **Definitions accumulate across runs.** One long-lived Lua state is reused so that a program which
  registers an event listener keeps working afterwards; the cost is that later runs see earlier
  runs' globals. (LiveCodes documents the same caveat for the ClojureScript compiler.)
- **A runtime error's line number is the line in the *compiled Lua*.** MoonScript's compiler can be
  asked to preserve line numbers — `compile_moonscript` takes an options string, and
  `{ correlate = true }` is what moonscript.org's own "Keep line numbers" checkbox sets — but this
  PoC does not use it, because correlating makes the compiled-Lua panel noisier. That is the fix, and
  it is a one-line change if errors are judged to matter more than readable output.
- **No stdin, argv or filesystem.** Lua's `print` is captured; `io.read` has nothing behind it.
- **The compiler is not linted or checked here.** The wasm exposes `lint_moonscript`, which
  moonscript.org wires to a Lint button; this PoC does not call it.
- **No source maps, no REPL protocol.** The compiled Lua is shown, which is not the same thing.

## Layout

```
index.html          the proof-of-concept page (editor, output, compiled Lua)
moonscript.js       the language layer: wasm compile step + Fengari run step
server.mjs          minimal static server for local development
```

## Verifying

| what | command |
| --- | --- |
| serve the page | `node server.mjs` → http://localhost:8131/ |
| syntax check | `npm run check` |

The page exposes `document.documentElement.dataset` (`status`, `runs`, `runMs`), `window.moon`, and
`window.__run` / `__editor` / `__output`, so scripted checks can read state without matching on
rendered text — the same approach the ClojureScript spike uses.

```js
// e.g. from a browser console, or an automation driver
await window.moon.run('print "hi"', { onPrint: (line) => console.log(line) });
```

## License

MIT © Hatem Hosny. MoonScript, Lua and LPeg are MIT (© Leaf Corcoran / PUC-Rio); the WebAssembly build
is from [`leafo/moonscript-javascript`](https://github.com/leafo/moonscript-javascript) (MIT); Fengari
is MIT. See [LICENSE](LICENSE).
