// BQ #14: eventos de agrupación. El docente sale siempre del token y los datos se validan.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-analitica-${sufijo}`;
const clave = "clave-segura-123";

let entorno;
let app;
let token;
let uid;

before(async () => {
  entorno = await initializeTestEnvironment({
    projectId: "enad-movil",
    firestore: { host: "127.0.0.1", port: 8080 },
  });
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    await ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Analítica", municipality: "Apía", active: true });
  });

  const correo = `ana.${sufijo}@enad.test`;
  const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: "Ana", schoolId: escuela });
  assert.strictEqual(registro.estado, 201, `register: ${JSON.stringify(registro.datos)}`);
  uid = registro.datos.uid;
  await entorno.withSecurityRulesDisabled((ctx) =>
    ctx.firestore().collection("users").doc(uid).update({ rol: "docente" }),
  );

  const login = await llamar("POST", "login", { email: correo, password: clave });
  app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, "analitica-ana");
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, login.datos.customToken);
  token = await auth.currentUser.getIdToken();
});

after(async () => {
  await entorno.cleanup();
  await deleteApp(app);
});

async function llamar(metodo, ruta, cuerpo, tk) {
  const headers = { "Content-Type": "application/json" };
  if (tk) headers.Authorization = `Bearer ${tk}`;
  const res = await fetch(`${BASE}/${ruta}`, { method: metodo, headers, body: cuerpo && JSON.stringify(cuerpo) });
  return { estado: res.status, datos: await res.json() };
}

const evento = (extra = {}) => ({ subject: "matematicas", classSize: 12, method: "manual", ...extra });

test("sin sesión no se puede registrar ni leer", async () => {
  assert.strictEqual((await llamar("POST", "analytics/grouping-events", evento())).estado, 401);
  assert.strictEqual((await llamar("GET", "analytics/grouping-events?subject=matematicas")).estado, 401);
});

test("el evento queda a nombre del token aunque el cuerpo diga otro docente", async () => {
  const r = await llamar("POST", "analytics/grouping-events", evento({ teacherId: "otro-docente" }), token);
  assert.strictEqual(r.estado, 201);
  assert.strictEqual(r.datos.teacherId, uid);
  assert.strictEqual(r.datos.createdBy, uid);
});

test("rechaza materia, tamaño, método y fecha inválidos", async () => {
  const malos = [
    evento({ subject: "ciencias" }),
    evento({ classSize: -1 }),
    evento({ classSize: 12.5 }),
    evento({ classSize: 10000 }),
    evento({ classSize: "12" }),
    evento({ method: "azar" }),
    evento({ timestamp: "no es una fecha" }),
    evento({ timestamp: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() }),
  ];
  for (const cuerpo of malos) {
    const r = await llamar("POST", "analytics/grouping-events", cuerpo, token);
    assert.strictEqual(r.estado, 400, `debía rechazar ${JSON.stringify(cuerpo)}`);
  }
});

test("acepta la hora en que se armó el grupo sin conexión", async () => {
  const hace = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  const r = await llamar("POST", "analytics/grouping-events", evento({ timestamp: hace }), token);
  assert.strictEqual(r.estado, 201);
  assert.strictEqual(r.datos.timestamp, hace);
});

test("el listado por materia trae los eventos guardados", async () => {
  const r = await llamar("GET", "analytics/grouping-events?subject=matematicas", undefined, token);
  assert.strictEqual(r.estado, 200);
  assert.ok(r.datos.events.length >= 1);
  assert.ok(r.datos.events.every((e) => e.subject === "matematicas"));
  const invalida = await llamar("GET", "analytics/grouping-events?subject=ciencias", undefined, token);
  assert.strictEqual(invalida.estado, 400);
});
