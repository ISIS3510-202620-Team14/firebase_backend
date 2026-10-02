// BQ #9: sesiones de clasificación y su reporte de minutos por cada 25 estudiantes.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-clasif-${sufijo}`;
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
    await ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Clasificación", municipality: "Apía", active: true });
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
    const app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `clasif-${nombre}`);
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

// Sesión que empezó hace una hora y duró `segundos` activos.
function sesion(clientId, segundos, clasificados, extra = {}) {
  const inicio = Date.now() - 60 * 60 * 1000;
  return {
    clientId, schoolId: escuela, subject: "lectura", platform: "kotlin", appVersion: "1.1 (2)",
    startedAt: new Date(inicio).toISOString(),
    endedAt: new Date(inicio + segundos * 1000).toISOString(),
    activeSeconds: segundos, studentsClassified: clasificados, studentsInList: 30,
    ...extra,
  };
}

test("una sesión se guarda una sola vez aunque la app la reintente", async () => {
  const cuerpo = sesion(`ana-1-${sufijo}`, 600, 10);
  const primera = await llamar("POST", "classificationSessions", cuerpo, tokens.ana);
  assert.strictEqual(primera.estado, 201);
  const reintento = await llamar("POST", "classificationSessions", cuerpo, tokens.ana);
  assert.strictEqual(reintento.estado, 200);
  assert.strictEqual(reintento.datos.stored, false);
});

test("el mismo clientId de otro docente no es un reintento", async () => {
  const { estado } = await llamar("POST", "classificationSessions", sesion(`ana-1-${sufijo}`, 600, 10), tokens.beto);
  assert.strictEqual(estado, 409);
});

test("no se aceptan sesiones de una institución ajena ni datos imposibles", async () => {
  const deAjena = await llamar("POST", "classificationSessions", sesion(`ana-x-${sufijo}`, 60, 2, { schoolId: ajena }), tokens.ana);
  assert.strictEqual(deAjena.estado, 403);

  // Más tiempo activo que el que pasó entre inicio y fin
  const imposible = sesion(`ana-y-${sufijo}`, 60, 2);
  imposible.activeSeconds = 5000;
  const r = await llamar("POST", "classificationSessions", imposible, tokens.ana);
  assert.strictEqual(r.estado, 400);
  assert.match(r.datos.error.message, /activeSeconds/);
});

test("el reporte da minutos por 25 estudiantes por docente y el promedio de la institución", async () => {
  // Ana: 600 s + 900 s para 10 + 15 estudiantes = 1500 s / 25 = 25 min por 25
  await llamar("POST", "classificationSessions", sesion(`ana-2-${sufijo}`, 900, 15), tokens.ana);
  // Beto: 150 s para 5 estudiantes = 30 s c/u -> 12.5 min por 25
  await llamar("POST", "classificationSessions", sesion(`beto-1-${sufijo}`, 150, 5), tokens.beto);

  const docente = await llamar("GET", `classificationSessions/report?schoolId=${escuela}`, undefined, tokens.ana);
  assert.strictEqual(docente.estado, 403);

  const { estado, datos } = await llamar("GET", `classificationSessions/report?schoolId=${escuela}`, undefined, tokens.admin);
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.schools.length, 1);
  const [ie] = datos.schools;
  const porNombre = Object.fromEntries(ie.teachers.map((t) => [t.fullName, t]));
  assert.strictEqual(porNombre.ana.minutesPer25, 25);
  assert.strictEqual(porNombre.ana.sessions, 2);
  assert.strictEqual(porNombre.beto.minutesPer25, 12.5);
  assert.strictEqual(ie.avgMinutesPer25, 18.8); // (25 + 12.5) / 2, cada docente pesa igual
  assert.strictEqual(ie.studentsClassified, 30);
});
