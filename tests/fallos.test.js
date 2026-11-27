// BQ tipo 1 de fallos: el resumen se prueba solo, sin emulador.
const { test } = require("node:test");
const assert = require("node:assert");
const { resumir, lunesDe } = require("../functions/fallos/resumen");

// Jueves 26/11/2026 al mediodía en Colombia
const AHORA = Date.parse("2026-11-26T17:00:00Z");
const DIA = 24 * 60 * 60 * 1000;

const sesion = (id, extra = {}) => ({ name: "app_session", sessionId: id, appVersion: "1.1 (2)", model: "Xiaomi 13", androidVersion: "34", createdAtMs: AHORA, ...extra });
const fallo = (id, extra = {}) => ({ name: "app_crash", sessionId: id, screen: "asistencia", createdAtMs: AHORA, ...extra });

test("sin eventos todo sale en cero", () => {
  const r = resumir([], 8, AHORA);
  assert.strictEqual(r.sessions, 0);
  assert.strictEqual(r.crashRate, null);
  assert.strictEqual(r.byWeek.length, 8);
  assert.strictEqual(r.byWeek[7].week, "2026-11-23");
  assert.strictEqual(r.provisional, true);
});

test("cuenta sesiones distintas aunque un evento llegue dos veces", () => {
  const r = resumir([sesion("a"), sesion("a"), sesion("b"), sesion("c"), sesion("d"), fallo("a"), fallo("a")], 8, AHORA);
  assert.strictEqual(r.sessions, 4);
  assert.strictEqual(r.crashes, 1);
  assert.strictEqual(r.crashRate, 25);
  assert.strictEqual(r.crashFreeRate, 75);
});

test("un fallo sin su sesión cuenta como sesión", () => {
  const r = resumir([fallo("x")], 8, AHORA);
  assert.strictEqual(r.sessions, 1);
  assert.strictEqual(r.crashRate, 100);
});

test("separa por pantalla, versión y semana", () => {
  const r = resumir([
    sesion("a"), fallo("a", { screen: "asistencia" }),
    sesion("b", { appVersion: "1.0 (1)" }), fallo("b", { screen: "admin_home" }),
    sesion("c"), fallo("c", { screen: "asistencia" }),
    sesion("d", { createdAtMs: AHORA - 7 * DIA }),
  ], 8, AHORA);
  assert.deepStrictEqual(r.byScreen[0], { screen: "asistencia", crashes: 2, share: 66.7 });
  assert.deepStrictEqual(r.byVersion.map((v) => [v.appVersion, v.sessions, v.crashes]), [["1.1 (2)", 3, 2], ["1.0 (1)", 1, 1]]);
  assert.deepStrictEqual(r.byWeek.slice(-2).map((w) => [w.week, w.sessions, w.crashes]), [["2026-11-16", 1, 0], ["2026-11-23", 3, 3]]);
});

test("el lunes se calcula en hora de Colombia", () => {
  // Lunes 23/11 a las 2 a. m. UTC todavía es domingo 22 en Colombia
  assert.strictEqual(lunesDe(Date.parse("2026-11-23T02:00:00Z")), "2026-11-16");
  assert.strictEqual(lunesDe(Date.parse("2026-11-23T06:00:00Z")), "2026-11-23");
});

