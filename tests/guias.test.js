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
