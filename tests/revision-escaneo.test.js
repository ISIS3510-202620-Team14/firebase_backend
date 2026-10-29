// BQ #11: qué tanto corrige el docente las filas del escáner antes de importar (eventos scan_review).
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-revision-${sufijo}`;
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
    ctx.firestore().collection("schools").doc(escuela).set({ name: "IE Revisión", municipality: "Apía", active: true }),
  );

  for (const nombre of ["docente", "admin"]) {
    const correo = `${nombre}.revision.${sufijo}@enad.test`;
    const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: nombre, schoolId: escuela });
    assert.strictEqual(registro.estado, 201, `register de ${nombre}: ${JSON.stringify(registro.datos)}`);
    await entorno.withSecurityRulesDisabled((ctx) =>
      ctx.firestore().collection("users").doc(registro.datos.uid).update({ rol: nombre === "admin" ? "admin" : "docente" }),
    );
    const login = await llamar("POST", "login", { email: correo, password: clave });
    const app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `revision-${nombre}`);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    await signInWithCustomToken(auth, login.datos.customToken);
    tokens[nombre] = await auth.currentUser.getIdToken();
  }

  // Dos importaciones recientes de docentes distintos y una de hace dos meses que no entra
  const hoy = new Date();
  const revisiones = [
    { teacherId: "t1", source: "attendance", rowsRead: 20, rowsUnchanged: 14, rowsEdited: 4, namesEdited: 3, codesEdited: 2, rowsDeleted: 2 },
    { teacherId: "t2", source: "manage_students", rowsRead: 10, rowsUnchanged: 6, rowsEdited: 3, namesEdited: 0, codesEdited: 3, rowsDeleted: 1 },
    { teacherId: "t2", source: "attendance", rowsRead: 30, rowsUnchanged: 0, rowsEdited: 30, namesEdited: 30, codesEdited: 0, rowsDeleted: 0,
      createdAt: new Date(hoy.getTime() - 60 * 24 * 60 * 60 * 1000) },
  ];
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    for (const r of revisiones) {
      await ctx.firestore().collection("events").add({ name: "scan_review", platform: "kotlin", createdAt: hoy, ...r });
    }
    await ctx.firestore().collection("events").add({ name: "scan_page", teacherId: "t1", rows: 9, createdAt: hoy });
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

test("solo el admin ve el reporte de revisión del escaneo", async () => {
  const { estado } = await llamar("GET", "analytics/scan-review", undefined, tokens.docente);
  assert.strictEqual(estado, 403);
});

test("suma lo que se dejó, corrigió y borró, y dice qué campo se corrige más", async () => {
  const { estado, datos } = await llamar("GET", "analytics/scan-review", undefined, tokens.admin);
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.imports, 2); // la de hace dos meses queda fuera
  assert.strictEqual(datos.teachers, 2);
  assert.strictEqual(datos.rowsRead, 30);
  assert.deepStrictEqual(datos.unchanged, { rows: 20, share: 66.7 });
  assert.deepStrictEqual(datos.edited, { rows: 7, share: 23.3 });
  assert.deepStrictEqual(datos.deleted, { rows: 3, share: 10 });
  assert.deepStrictEqual(datos.fields, [
    { key: "name", rows: 3, share: 10 },
    { key: "code", rows: 5, share: 16.7 },
  ]);
  assert.strictEqual(datos.mostCorrected, "code");

  const desdeAsistencia = datos.bySource.find((s) => s.key === "attendance");
  assert.strictEqual(desdeAsistencia.imports, 1);
  assert.strictEqual(desdeAsistencia.edited.share, 20);
});

test("weeks fuera de rango es un error", async () => {
  const { estado } = await llamar("GET", "analytics/scan-review?weeks=99", undefined, tokens.admin);
  assert.strictEqual(estado, 400);
});
