// Solves the planner's LP text with HiGHS (WebAssembly) off the main thread, so the page stays responsive.
'use strict';
const HIGHS = 'https://cdn.jsdelivr.net/npm/highs@1.15.4/build/';
self.module = { exports: {} };
self.exports = self.module.exports;
importScripts(HIGHS + 'highs.js');
const factory = typeof self.module.exports === 'function' ? self.module.exports : self.Module;

self.onmessage = async (e) => {
  try {
    // A fresh solver each time: one that hit an error is not safe to reuse.
    const highs = await factory({ locateFile: (file) => HIGHS + file });
    const sol = highs.solve(e.data.lp, e.data.options || {});
    const values = {};
    Object.entries(sol.Columns || {}).forEach(([name, c]) => { values[name] = c.Primal; });
    self.postMessage({ id: e.data.id, ok: true, status: sol.Status, objective: sol.ObjectiveValue, values });
  } catch (err) {
    self.postMessage({ id: e.data.id, ok: false, error: String((err && err.message) || err) });
  }
};
