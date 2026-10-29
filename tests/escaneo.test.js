// BQ #10: calidad de las páginas escaneadas según las condiciones de la foto (eventos scan_page).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-escaneo-${sufijo}`;
const clave = "clave-segura-123";

let entorno;
const apps = [];
const tokens = {};

before(async () => {
  entorno = await initializeTestEnvironment({
    projectId: "enad-movil",
    firestore: { host: "127.0.0.1", port: 8080 },
  });
  await entorno.withSecurityRulesDisabled((ctx) =>
    ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Escaneo", municipality: "Apía", active: true }),
  );

  for (const nombre of ["docente", "admin"]) {
    const correo = `${nombre}.escaneo.${sufijo}@enad.test`;
    const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: nombre, schoolId: escuela });
    assert.strictEqual(registro.estado, 201, `register de ${nombre}: ${JSON.stringify(registro.datos)}`);
    await entorno.withSecurityRulesDisabled((ctx) =>
      ctx.firestore().collection("users").doc(registro.datos.uid).update({ rol: nombre === "admin" ? "admin" : "docente" }),
    );
    const login = await llamar("POST", "login", { email: correo, password: clave });
    const app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `escaneo-${nombre}`);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    await signInWithCustomToken(auth, login.datos.customToken);
    tokens[nombre] = await auth.currentUser.getIdToken();
  }

  // Dos docentes; uno usa el disparo automático. La última página es de hace dos meses y no entra.
  const hoy = new Date();
  const paginas = [
    { teacherId: "t1", lightLevel: "good", steady: true, torch: false, autoCapture: true, rows: 20, ocrFailed: false },
    { teacherId: "t1", lightLevel: "good", steady: true, torch: false, autoCapture: false, rows: 18, ocrFailed: false },
    { teacherId: "t2", lightLevel: "low", steady: false, torch: false, autoCapture: false, rows: 6, ocrFailed: false },
    { teacherId: "t2", lightLevel: "dark", steady: true, torch: true, autoCapture: false, rows: 0, ocrFailed: false },
    { teacherId: "t2", lightLevel: "glare", steady: false, torch: false, autoCapture: false, rows: 0, ocrFailed: true },
    { teacherId: "t2", lightLevel: "good", steady: true, torch: false, autoCapture: false, rows: 30, ocrFailed: false,
      createdAt: new Date(hoy.getTime() - 60 * 24 * 60 * 60 * 1000) },
  ];
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    for (const p of paginas) {
      await ctx.firestore().collection("events").add({ name: "scan_page", platform: "kotlin", lux: 100, ocrMs: 900, createdAt: hoy, ...p });
    }
    // Otro tipo de evento no cuenta
    await ctx.firestore().collection("events").add({ name: "activity_selected", teacherId: "t1", createdAt: hoy });
  });
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

const fila = (grupo, clave) => grupo.find((g) => g.key === clave);

test("solo el admin ve el reporte de escaneo", async () => {
  const { estado } = await llamar("GET", "analytics/scan-quality", undefined, tokens.docente);
  assert.strictEqual(estado, 403);
});

test("compara las páginas listas con las demás y cuenta el disparo automático", async () => {
  const { estado, datos } = await llamar("GET", "analytics/scan-quality", undefined, tokens.admin);
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.pages, 5); // la de hace dos meses queda fuera de las 8 semanas
  assert.strictEqual(datos.teachers, 2);

  // Listas: 20 y 18 filas, ninguna falla. Las demás: 6, 0 (sin filas) y 0 (falla del OCR)
  assert.deepStrictEqual(fila(datos.ready, "ready"), { key: "ready", pages: 2, avgRows: 19, failureRate: 0 });
  assert.deepStrictEqual(fila(datos.ready, "not_ready"), { key: "not_ready", pages: 3, avgRows: 2, failureRate: 66.7 });

  assert.strictEqual(fila(datos.light, "dark").pages, 1);
  assert.strictEqual(fila(datos.light, "unknown").pages, 0);
  assert.strictEqual(fila(datos.light, "unknown").avgRows, null);
  assert.strictEqual(fila(datos.steadiness, "moving").pages, 2);
  assert.strictEqual(fila(datos.torch, "on").failureRate, 100);

  assert.strictEqual(datos.autoCapture.pagesShare, 20);
  assert.strictEqual(datos.autoCapture.teachers, 1);
  assert.strictEqual(datos.autoCapture.teachersShare, 50);
});

test("weeks fuera de rango es un error", async () => {
  const { estado } = await llamar("GET", "analytics/scan-quality?weeks=0", undefined, tokens.admin);
  assert.strictEqual(estado, 400);
});
