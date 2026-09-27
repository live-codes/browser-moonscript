/**
 * MoonScript layer for the browser PoC.
 *
 * MoonScript is a language that compiles to Lua, so "run MoonScript in the
 * browser" is really two jobs:
 *
 *   1. compile MoonScript -> Lua
 *   2. run that Lua
 *
 * Both have to happen client-side, with no server. This module does them with
 * two separate runtimes, which is deliberate:
 *
 *   compile  leafo/moonscript-javascript — MoonScript, Lua and LPeg compiled to
 *            WebAssembly. This is the compiler that powers
 *            moonscript.org/compiler, and it is the only way to get the real
 *            MoonScript parser in a browser, because the parser is built on
 *            LPeg, a C extension with no pure-Lua and no JS equivalent.
 *            `versions()` reports what is actually bundled inside it.
 *
 *   execute  Fengari — Lua 5.3 in JavaScript. This is the same runtime
 *            LiveCodes already uses for the `lua` language (and for the Fennel
 *            and Teal compilers), and unlike the wasm compiler it can reach the
 *            DOM: `require "js"` works, exactly as it does for Lua and Fennel.
 *
 * The split matters for integration. LiveCodes compiles a language to another
 * language and then runs *that*; a `moonscript` LanguageSpecs entry wants
 * `compiledCodeLanguage: 'lua'` and `scriptType: 'application/lua'`, the same
 * shape `fennel` and `teal` already use. Using the wasm for the compile step
 * and the existing Lua runtime for the run step keeps MoonScript a first-class
 * language there rather than a walled garden that cannot touch the page.
 *
 * The shape here (name + title + extensions + compile/run + examples) is
 * intentionally close to a LiveCodes `LanguageSpecs` entry so it can be lifted
 * into the real integration.
 */

export const name = 'moonscript';
export const title = 'MoonScript';
export const extensions = ['moon'];

/**
 * Pinned to leafo/moonscript-javascript @ 0cc6cf1 — the commit that made the
 * wasm file cross-origin loadable, which is what lets us fetch it from a CDN.
 * The glue is an ES module that resolves `moonscript.wasm` relative to itself.
 */
const COMPILER_BASE =
  'https://cdn.jsdelivr.net/gh/leafo/moonscript-javascript@0cc6cf1720ae2c7fcef5d0bd60ae1d4b6b16e462/worker/';

// ---------------------------------------------------------------------------
// compile: MoonScript -> Lua, via the WebAssembly compiler
// ---------------------------------------------------------------------------

let compilerModule = null;
let printHandler = null;

/**
 * The wasm binds `Module.print` once, at init, so it cannot be swapped later.
 * Hand everything through one indirection instead: the compiler's own stdout
 * (warnings, and the `print` used by `run_moonscript`) lands wherever
 * `printHandler` currently points, and falls back to the console.
 */
async function compiler() {
  if (!compilerModule) {
    const { default: factory } = await import(/* @vite-ignore */ COMPILER_BASE + 'moonscript.js');
    compilerModule = await factory({
      print: (text) => (printHandler ? printHandler(text) : console.log(text)),
      printErr: (text) => console.error('[moonscript]', text),
    });
  }
  return compilerModule;
}

/**
 * Compile MoonScript source to Lua.
 *
 * `log` carries anything the compiler wrote to stdout while compiling.
 *
 * Note: the C API behind this (`compile_moonscript`) returns the compiled Lua
 * and the error message in the same slot with no way to tell them apart — its
 * own source says "We currently make no distinction between compiled code and
 * an error". So this returns the string as-is and `run()` below decides which
 * one it was, by asking a Lua parser. See the comment there (it matters).
 */
export async function compile(code) {
  const Module = await compiler();
  const log = [];
  const previous = printHandler;
  printHandler = (text) => log.push(text);
  try {
    const lua = Module.ccall('compile_moonscript', 'string', ['string', 'string'], [String(code), '']);
    return { lua, log };
  } finally {
    printHandler = previous;
  }
}

/**
 * Versions of what is actually inside the wasm, read by evaluating code in it.
 * Worth reading rather than hard-coding: the wasm bundles a newer MoonScript,
 * Lua and LPeg than the repository's README claims.
 *
 * Note the trap: `run_moonscript` compiles its input as *MoonScript*, not Lua,
 * so these probes have to be valid MoonScript. Two of them look like Lua only
 * because `return require('x').y` happens to parse as both.
 */
export async function versions() {
  const Module = await compiler();
  const evaluate = (source) =>
    Module.ccall('run_moonscript', 'string', ['string'], [source]).trim();
  return {
    moonscript: evaluate("return require('moonscript.version').version"),
    lua: evaluate('return LUA_RELEASE or _VERSION'),
    // LPeg reports itself as "LPeg 1.1.0" (name included) and exposes the
    // version as a plain field in some releases and a function in others, so
    // accept either rather than guessing.
    lpeg: evaluate(
      [
        "v = require('lpeg').version",
        'return type(v) == "function" and v() or v',
      ].join('\n'),
    ),
  };
}

// ---------------------------------------------------------------------------
// execute: Lua, via Fengari
// ---------------------------------------------------------------------------

let L = null;
let onPrint = () => {};

/**
 * Capture the program's `print` into a JS callback. `select`/`tostring` are
 * done in Lua so that any value prints the way Lua would print it.
 */
const PRELUDE = `
local emit = __emit
print = function(...)
  local parts = {}
  for i = 1, select("#", ...) do
    parts[i] = tostring((select(i, ...)))
  end
  emit(table.concat(parts, "\\t"))
end
`;

/**
 * One long-lived Lua state, not one per run. That is what LiveCodes does for a
 * result frame, and it is what makes a program that registers an event listener
 * (`document:addEventListener`) keep working after the run that registered it.
 * The trade-off is that definitions persist across runs.
 */
function ensureLua() {
  if (L) return L;
  if (!self.fengari) {
    throw new Error('The Lua runtime (Fengari) has not loaded yet.');
  }
  const { lua, lauxlib, lualib, to_luastring, to_jsstring } = self.fengari;

  L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);

  // `js` is what makes this a browser language rather than a calculator.
  lauxlib.luaL_requiref(L, to_luastring('js'), self.fengari.interop.luaopen_js, 1);
  lua.lua_pop(L, 1);

  lua.lua_pushjsfunction(L, (L) => {
    const n = lua.lua_gettop(L);
    const parts = [];
    for (let i = 1; i <= n; i++) {
      parts.push(to_jsstring(lua.lua_tostring(L, i)));
    }
    onPrint(parts.join('\t'));
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('__emit'));

  const status = lauxlib.luaL_loadstring(L, to_luastring(PRELUDE));
  if (status !== lua.LUA_OK) {
    throw new Error(to_jsstring(lua.lua_tostring(L, -1)));
  }
  lua.lua_pcall(L, 0, 0, 0);

  return L;
}

/**
 * Compile and then run. `print` is streamed to `options.onPrint` as it happens
 * (which is what lets the DOM example keep writing to the page after the run
 * has returned).
 *
 * Returns `{ lua, error }`:
 *   - `lua`   the compiled Lua, when there is any
 *   - `error` `{ kind, message }` with kind `'compile'` or `'runtime'`, if not
 */
export async function run(code, options = {}) {
  onPrint = options.onPrint || (() => {});

  const { lua: compiled, log } = await compile(code);

  // Empty input compiles to empty Lua; nothing to report.
  if (!String(compiled).trim()) {
    return { lua: '', log, error: null };
  }

  const state = ensureLua();
  const { lua, lauxlib, to_luastring, to_jsstring } = self.fengari;

  // Load with a chunk name rather than `luaL_loadstring`, which would use the
  // entire source as the chunk name and make every runtime error message start
  // with a copy of the program. The `=` prefix is Lua's way of saying "use this
  // name literally", so errors read `moon:2: ...` instead of `[string "moon"]`.
  const bytes = to_luastring(compiled);
  const status = lauxlib.luaL_loadbuffer(state, bytes, bytes.length, to_luastring('=moon'));

  if (status !== lua.LUA_OK) {
    // Not valid Lua, so `compile_moonscript` handed back an error message
    // rather than code. Report the message itself — the Lua parser's complaint
    // is only about the *shape of the error text* and is never useful.
    const noise = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    console.debug('[moonscript] compiler returned a non-Lua string:', noise);
    return { lua: null, log, error: { kind: 'compile', message: String(compiled) } };
  }

  const result = lua.lua_pcall(state, 0, 0, 0);
  if (result !== lua.LUA_OK) {
    const message = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    return { lua: compiled, log, error: { kind: 'runtime', message } };
  }

  return { lua: compiled, log, error: null };
}

// ---------------------------------------------------------------------------
// examples
// ---------------------------------------------------------------------------

export const examples = [
  {
    name: 'Hello & interpolation',
    code: [
      '-- comments start with --',
      'print "Hello from MoonScript!"',
      '',
      'name = "the browser"',
      'print "Compiled to Lua, then run in #{name}."',
      '',
      '-- no parentheses needed for calls',
      'print "2 + 2 = #{2 + 2}"',
    ].join('\n'),
  },
  {
    name: 'Functions & recursion',
    code: [
      '-- `->` is a function, `=>` is a method (it gets `self`)',
      'fact = (n) ->',
      '  return 1 if n <= 1',
      '  n * fact(n - 1)',
      '',
      'for i = 1, 10',
      '  print "#{i}! = #{fact(i)}"',
    ].join('\n'),
  },
  {
    name: 'Tables & comprehensions',
    code: [
      'nums = {1, 2, 3, 4, 5, 6}',
      '',
      '-- `*nums` unpacks a table as an iterator',
      'squares = [n * n for n in *nums]',
      'evens = [n for n in *nums when n % 2 == 0]',
      '',
      'print "nums:    " .. table.concat(nums, ", ")',
      'print "squares: " .. table.concat(squares, ", ")',
      'print "evens:   " .. table.concat(evens, ", ")',
      '',
      'total = 0',
      'for n in *nums',
      '  total += n',
      'print "total:   #{total}"',
    ].join('\n'),
  },
  {
    name: 'Classes & inheritance',
    code: [
      'class Shape',
      '  new: (name) =>',
      '    @name = name',
      '',
      '  area: => 0',
      '',
      '  describe: =>',
      '    print "#{@name} has area #{@area!}"',
      '',
      'class Circle extends Shape',
      '  new: (radius) =>',
      '    super("circle")',
      '    @radius = radius',
      '',
      '  area: => 3.14159 * @radius ^ 2',
      '',
      'class Square extends Shape',
      '  new: (side) =>',
      '    super("square")',
      '    @side = side',
      '',
      '  area: => @side * @side',
      '',
      'Circle(2)\\describe!',
      'Square(3)\\describe!',
    ].join('\n'),
  },
  {
    name: 'DOM interop (require "js")',
    code: [
      '-- runs on Fengari, so the `js` interop library is available',
      'js = require "js"',
      '',
      'document = js.global.document',
      'target = document\\getElementById "dom-target"',
      '',
      'stamp = os.date "%H:%M:%S"',
      'target.innerHTML = "Written by <b>MoonScript</b> at #{stamp}"',
      '',
      'print "Updated #dom-target from MoonScript."',
    ].join('\n'),
  },
];

export default { name, title, extensions, compile, run, versions, examples };
