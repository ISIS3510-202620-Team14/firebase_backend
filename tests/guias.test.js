// BQ tipo 3 de las guías: el resumen se prueba solo, sin emulador.
const { test } = require("node:test");
const assert = require("node:assert");
const { resumir } = require("../functions/guias/resumen");

const ev = (name, run, extra = {}) => ({ name, tutorial_id: "attendance", run_id: run, step: 0, platform: "kotlin", ...extra });

function asistencia(eventos) {
  return resumir(eventos).find((g) => g.id === "attendance");
}

test("sin eventos salen las cuatro guías en cero", () => {
  const r = resumir([]);
  assert.deepStrictEqual(r.map((g) => g.id), ["hours", "attendance", "evaluation", "activities"]);
  r.forEach((g) => {
    assert.strictEqual(g.runs, 0);
    assert.strictEqual(g.completionRate, null);
  });
});

test("cuenta corridas distintas aunque un evento llegue dos veces", () => {
  const g = asistencia([
    ev("tutorial_started", "a"), ev("tutorial_started", "a"),
    ev("tutorial_started", "b", { platform: "flutter" }),
    ev("tutorial_completed", "a"), ev("tutorial_completed", "a"),
  ]);
  assert.strictEqual(g.runs, 2);
  assert.strictEqual(g.completed, 1);
  assert.strictEqual(g.completionRate, 50);
  assert.deepStrictEqual(g.byPlatform, { kotlin: 1, flutter: 1 });
});

test("el paso donde más abandonan sale primero", () => {
  const g = asistencia([
    ev("tutorial_started", "a"), ev("tutorial_abandoned", "a", { step: 3 }),
    ev("tutorial_started", "b"), ev("tutorial_abandoned", "b", { step: 3 }),
    ev("tutorial_started", "c"), ev("tutorial_abandoned", "c", { step: 1 }),
  ]);
  assert.strictEqual(g.abandoned, 3);
  assert.deepStrictEqual(g.abandonedAtStep, [{ step: 3, runs: 2 }, { step: 1, runs: 1 }]);
});

test("los pasos omitidos se cuentan una vez por corrida", () => {
  const g = asistencia([
    ev("tutorial_started", "a"), ev("tutorial_step_skipped", "a", { step: 2 }), ev("tutorial_step_skipped", "a", { step: 2 }),
    ev("tutorial_started", "b"), ev("tutorial_step_skipped", "b", { step: 2 }), ev("tutorial_step_skipped", "b", { step: 4 }),
  ]);
  assert.deepStrictEqual(g.skippedSteps, [{ step: 2, runs: 2 }, { step: 4, runs: 1 }]);
});

test("no cuentan corridas que no empezaron en el rango ni guías desconocidas", () => {
  const g = asistencia([
    ev("tutorial_completed", "vieja"),
    ev("tutorial_abandoned", "vieja", { step: 1 }),
    ev("tutorial_started", "x", { tutorial_id: "otra" }),
    ev("tutorial_started", "c"), ev("tutorial_abandoned", "c", { step: -1 }),
  ]);
  assert.strictEqual(g.runs, 1);
  assert.strictEqual(g.completed, 0);
  assert.deepStrictEqual(g.abandonedAtStep, []);
});

test("una corrida que se terminó no cuenta como abandonada", () => {
  const g = asistencia([
    ev("tutorial_started", "a"), ev("tutorial_abandoned", "a", { step: 2 }), ev("tutorial_completed", "a"),
  ]);
  assert.strictEqual(g.abandoned, 0);
});


test("steps from different platforms or versions never share a report", () => {
  const { seleccionar } = require("../functions/guias/resumen");
  const events = [
    ev("tutorial_started", "f", {platform:"flutter", tutorial_version:2}),
    ev("tutorial_abandoned", "f", {platform:"flutter", tutorial_version:2, step:2}),
    ev("tutorial_started", "k", {tutorial_version:2}),
    ev("tutorial_abandoned", "k", {tutorial_version:2, step:2}),
    ev("tutorial_started", "old", {platform:"flutter", tutorial_version:1}),
    ev("tutorial_started", "unknown", {platform:"flutter"}),
  ];
  const selected = seleccionar(events,"flutter",2);
  assert.strictEqual(selected.length,2);
  assert.deepStrictEqual(asistencia(selected).abandonedAtStep,[{step:2,runs:1}]);
  assert.strictEqual(asistencia(selected).runs,1);
  assert.strictEqual(seleccionar(events,"kotlin",2).length,2);
});


test("report validates access, filters steps and reads bounded pages", async () => {
  const Module = require("node:module");
  const original = Module._load;
  const calls = [];
  let page = 0;
  const items = [
    ev("tutorial_started", "f", { platform:"flutter", tutorial_version:2 }),
    ev("tutorial_abandoned", "f", { platform:"flutter", tutorial_version:2, step:2 }),
    ev("tutorial_started", "k", { tutorial_version:2 }),
  ];
  const query = {
    where(field, op) {
      assert.ok((field === "createdAt" && op === ">=") || (field === "name" && op === "in"));
      return this;
    },
    orderBy(field) { assert.strictEqual(field,"createdAt"); return this; },
    limit(count) { assert.strictEqual(count,500); return this; },
    startAfter(cursor) { calls.push(cursor); return this; },
    async get() {
      const data = page++ === 0 ? [...items, ...Array(497).fill({name:"unrelated"})] : [];
      const docs = data.map((value) => ({data:() => value}));
      return {size:docs.length,docs};
    },
  };
  Module._load = function (name, parent, isMain) {
    if (name === "firebase-admin/firestore") return {
      getFirestore:() => ({collection:() => query}), Timestamp:{fromMillis:(n) => n},
    };
    if (name === "../estudiantes/auth") return {
      autenticar(req,res,next) { req.usuario={rol:req.headers['x-role'] || 'admin'}; next(); },
    };
    return original.call(this,name,parent,isMain);
  };
  let app;
  try { app = require("../functions/guias/index"); } finally { Module._load = original; }
  const server = app.listen(0,"127.0.0.1");
  await new Promise((resolve) => server.once("listening",resolve));
  const base = `http://127.0.0.1:${server.address().port}/report`;
  try {
    assert.strictEqual((await fetch(base,{headers:{'x-role':'docente'}})).status,403);
    assert.strictEqual((await fetch(base+'?platform=other')).status,400);
    assert.strictEqual((await fetch(base+'?version=bad')).status,400);
    assert.strictEqual((await fetch(base+'?weeks=0')).status,400);
    const report = await (await fetch(base+'?platform=flutter&version=2')).json();
    assert.strictEqual(report.platform,'flutter');
    assert.strictEqual(report.tutorials.find((g)=>g.id==='attendance').runs,1);
    assert.strictEqual(report.excluded,1);
    assert.strictEqual(calls.length,1);
    page=0;
    const kotlin = await (await fetch(base)).json();
    assert.strictEqual(kotlin.platform,'kotlin');
    assert.strictEqual(kotlin.tutorials.find((g)=>g.id==='attendance').runs,1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
