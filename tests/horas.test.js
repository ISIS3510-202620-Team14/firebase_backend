// Horas realizadas por día: se guardan una vez por docente y día, y el reporte las resume por semana.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-horas-${sufijo}`;
const ajena = `ie-ajena-${sufijo}`;
const clave = "clave-segura-123";

let entorno;
const apps = [];
const tokens = {};

before(async () => {
  entorno = await initializeTestEnvironment({
    projectId: "enad-movil",
    firestore: { host: "127.0.0.1", port: 8080 },
  });
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Horas", municipality: "Apía", active: true });
    await ctx.firestore().collection("schools").doc(ajena).set({ name: "IE Ajena", municipality: "Apía", active: true });
  });

  for (const nombre of ["ana", "beto", "admin"]) {
    const correo = `${nombre}.${sufijo}@enad.test`;
    const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: nombre, schoolId: escuela });
    assert.strictEqual(registro.estado, 201, `register de ${nombre}: ${JSON.stringify(registro.datos)}`);
    await entorno.withSecurityRulesDisabled((ctx) =>
      ctx.firestore().collection("users").doc(registro.datos.uid).update({ rol: nombre === "admin" ? "admin" : "docente" }),
    );
    const login = await llamar("POST", "login", { email: correo, password: clave });
    const app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `horas-${nombre}`);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    await signInWithCustomToken(auth, login.datos.customToken);
    tokens[nombre] = await auth.currentUser.getIdToken();
  }
});

after(async () => {
  await entorno.cleanup();
  await Promise.all(apps.map(deleteApp));
});

async function llamar(metodo, ruta, cuerpo, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/${ruta}`, { method: metodo, headers, body: cuerpo && JSON.stringify(cuerpo) });
  return { estado: res.status, datos: await res.json() };
}

const ayer = new Date(Date.now() - 24 * 60 * 60 * 1000 - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

function reporte(extra = {}) {
  return {
    schoolId: escuela, plannedHours: 2, workedHours: 2, origin: "suggested", presentAtCampus: true,
    platform: "kotlin", appVersion: "1.1 (2)", savedAt: new Date().toISOString(),
    ...extra,
  };
}

test("el reporte del día se guarda y uno más viejo no pisa a uno más nuevo", async () => {
  const nuevo = await llamar("PUT", `workedHours/${ayer}`, reporte(), tokens.ana);
  assert.strictEqual(nuevo.estado, 200);
  assert.strictEqual(nuevo.datos.stored, true);

  const viejo = reporte({ workedHours: 1, origin: "manual", reason: "Llovió", savedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
  const r = await llamar("PUT", `workedHours/${ayer}`, viejo, tokens.ana);
  assert.strictEqual(r.estado, 200);
  assert.strictEqual(r.datos.stored, false);

  const corregido = await llamar("PUT", `workedHours/${ayer}`, reporte({ workedHours: 1.5, origin: "manual", reason: "Salimos temprano", savedAt: new Date(Date.now() + 1000).toISOString() }), tokens.ana);
  assert.strictEqual(corregido.datos.stored, true);
});

test("cada docente tiene su propio reporte del mismo día", async () => {
  const { estado, datos } = await llamar("PUT", `workedHours/${ayer}`, reporte({ workedHours: 0, origin: "manual", reason: "Paro" }), tokens.beto);
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.stored, true);
});

test("se rechazan datos imposibles, escuelas ajenas y reportes sin sede que dicen ser sugeridos", async () => {
  const llamarPut = (fecha, extra) => llamar("PUT", `workedHours/${fecha}`, reporte(extra), tokens.ana);

  const ajena_ = await llamarPut(ayer, { schoolId: ajena });
  assert.strictEqual(ajena_.estado, 403);

  const futuro = await llamarPut("2999-01-01", {});
  assert.strictEqual(futuro.estado, 400);
  assert.match(futuro.datos.error.message, /date/);

  const sinMotivo = await llamarPut(ayer, { workedHours: 1, origin: "manual" });
  assert.strictEqual(sinMotivo.estado, 400);
  assert.match(sinMotivo.datos.error.message, /reason/);

  const sinSede = await llamarPut(ayer, { presentAtCampus: false });
  assert.strictEqual(sinSede.estado, 400);
  assert.match(sinSede.datos.error.message, /origin/);

  const demasiadas = await llamarPut(ayer, { workedHours: 30, origin: "manual" });
  assert.strictEqual(demasiadas.estado, 400);
  assert.match(demasiadas.datos.error.message, /workedHours/);

  const sinToken = await llamar("PUT", `workedHours/${ayer}`, reporte());
  assert.strictEqual(sinToken.estado, 401);
});

test("el reporte resume por semana lo planeado, lo realizado y cuántas veces se aceptó la sugerencia", async () => {
  const docente = await llamar("GET", `workedHours/report?schoolId=${escuela}`, undefined, tokens.ana);
  assert.strictEqual(docente.estado, 403);

  const { estado, datos } = await llamar("GET", `workedHours/report?schoolId=${escuela}`, undefined, tokens.admin);
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.summary.length, 1);
  const [semana] = datos.summary;
  // Ana quedó con 1.5 h escritas a mano y Beto con 0 h: 2 h planeadas cada uno
  assert.strictEqual(semana.days, 2);
  assert.strictEqual(semana.teachers, 2);
  assert.strictEqual(semana.plannedHours, 4);
  assert.strictEqual(semana.workedHours, 1.5);
  assert.strictEqual(semana.suggested, 0);
  assert.strictEqual(semana.manual, 2);
  assert.strictEqual(semana.withReason, 2);
});
