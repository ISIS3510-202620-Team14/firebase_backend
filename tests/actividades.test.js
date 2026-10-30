// Activity planning (F09): Flutter plans library activities and the teacher's own activities through the sync API.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-actividades-${sufijo}`;
const plantilla = `mat-${sufijo}`;
const clave = "clave-segura-123";
const hoy = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
    await ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Actividades", municipality: "Apía", active: true });
    await ctx.firestore().collection("activityLibrary").doc(plantilla).set({
      title: "Tienda del salón", subject: "matematicas", minutes: 30, description: "Comprar con billetes de papel.", active: true,
    });
  });
  const correo = `docente.${sufijo}@enad.test`;
  const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: "Docente", schoolId: escuela });
  assert.strictEqual(registro.estado, 201, JSON.stringify(registro.datos));
  uid = registro.datos.uid;
  await entorno.withSecurityRulesDisabled((ctx) => ctx.firestore().collection("users").doc(uid).update({ rol: "docente" }));
  const login = await llamar("POST", "login", { email: correo, password: clave });
  app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `actividades-${sufijo}`);
  const auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  await signInWithCustomToken(auth, login.datos.customToken);
  token = await auth.currentUser.getIdToken();
});

after(async () => {
  await entorno.cleanup();
  await deleteApp(app);
});

async function llamar(metodo, ruta, cuerpo, conToken) {
  const headers = { "Content-Type": "application/json" };
  if (conToken) headers.Authorization = `Bearer ${conToken}`;
  const res = await fetch(`${BASE}/${ruta}`, { method: metodo, headers, body: cuerpo && JSON.stringify(cuerpo) });
  return { estado: res.status, datos: await res.json() };
}

function planear(activityId, body) {
  return llamar("POST", "sync/v1/operations", {
    operationId: `op-${activityId}`, key: `plans/${activityId}`, baseVersion: null, action: "create", body,
  }, token);
}

async function leer(ruta) {
  let datos;
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    datos = (await ctx.firestore().doc(ruta).get()).data();
  });
  return datos;
}

test("an own activity is saved with its name, subject and minutes", async () => {
  const id = `propia-${sufijo}`;
  const r = await planear(id, { source: "custom", title: "  Juego de fracciones ", subject: "matematicas", minutes: 25, date: hoy });
  assert.strictEqual(r.estado, 200, JSON.stringify(r.datos));
  assert.strictEqual(r.datos.state, "confirmed");

  const plan = await leer(`users/${uid}/actions/flutter_activity_${id}`);
  assert.strictEqual(plan.source, "custom");
  assert.strictEqual(plan.title, "Juego de fracciones");
  assert.strictEqual(plan.minutes, 25);
  assert.strictEqual(plan.templateId, undefined);

  const evento = await leer(`events/flutter_activity_${id}`);
  assert.strictEqual(evento.name, "activity_selected");
  assert.strictEqual(evento.source, "custom");
  assert.strictEqual(evento.subject, "matematicas");
});

test("a library activity takes its data from the library, not from the phone", async () => {
  const id = `biblioteca-${sufijo}`;
  const r = await planear(id, { templateId: plantilla, title: "Otro nombre", minutes: 99, date: hoy });
  assert.strictEqual(r.estado, 200, JSON.stringify(r.datos));

  const plan = await leer(`users/${uid}/actions/flutter_activity_${id}`);
  assert.strictEqual(plan.source, "library");
  assert.strictEqual(plan.title, "Tienda del salón");
  assert.strictEqual(plan.minutes, 30);
  const evento = await leer(`events/flutter_activity_${id}`);
  assert.strictEqual(evento.source, "library");
  assert.strictEqual(evento.templateId, plantilla);
});

test("an own activity with a short name, bad minutes or an unknown subject is rejected", async () => {
  const malas = [
    { source: "custom", title: "ab", subject: "lectura", minutes: 10, date: hoy },
    { source: "custom", title: "Lectura libre", subject: "lectura", minutes: 0, date: hoy },
    { source: "custom", title: "Lectura libre", subject: "lectura", minutes: 2.5, date: hoy },
    { source: "custom", title: "Lectura libre", subject: "ciencias", minutes: 10, date: hoy },
  ];
  for (const [i, body] of malas.entries()) {
    const r = await planear(`mala-${i}-${sufijo}`, body);
    assert.strictEqual(r.estado, 400, `case ${i}: ${JSON.stringify(r.datos)}`);
  }
});
