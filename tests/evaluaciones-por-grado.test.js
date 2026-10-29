// BQ #12 (tipo 4): evaluaciones por materia y por grado, solo para el admin.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuela = `ie-bq12-${sufijo}`;
const otra = `ie-bq12-otra-${sufijo}`;
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
    await ctx.firestore().collection("schools").doc(escuela).set({ name: "IE BQ12", municipality: "Apía", active: true });
    await ctx.firestore().collection("schools").doc(otra).set({ name: "IE Otra", municipality: "Apía", active: true });
  });

  for (const nombre of ["ana", "admin"]) {
    const correo = `${nombre}.${sufijo}@enad.test`;
    const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: nombre, schoolId: escuela });
    assert.strictEqual(registro.estado, 201, `register de ${nombre}: ${JSON.stringify(registro.datos)}`);
    await entorno.withSecurityRulesDisabled((ctx) =>
      ctx.firestore().collection("users").doc(registro.datos.uid).update({ rol: nombre === "admin" ? "admin" : "docente" }),
    );
    const login = await llamar("POST", "login", { email: correo, password: clave });
    const app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, `bq12-${nombre}`);
    apps.push(app);
    const auth = getAuth(app);
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    await signInWithCustomToken(auth, login.datos.customToken);
    tokens[nombre] = await auth.currentUser.getIdToken();
  }

  // Grado 3: 3 de matemáticas y 1 de lectura. Grado 4: 1 de matemáticas y 2 de lectura.
  // Grado 5: 2 y 2 (empate). Un estudiante dado de baja y uno de otra escuela no cuentan.
  await sembrar({ id: "g3", schoolId: escuela, grade: 3, evaluaciones: ["matematicas", "matematicas", "lectura"] });
  await sembrar({ id: "g3b", schoolId: escuela, grade: 3, evaluaciones: ["matematicas"] });
  await sembrar({ id: "g4", schoolId: escuela, grade: 4, evaluaciones: ["matematicas", "lectura", "lectura"] });
  await sembrar({ id: "g5", schoolId: escuela, grade: 5, evaluaciones: ["matematicas", "lectura", "lectura", "matematicas"] });
  await sembrar({ id: "baja", schoolId: escuela, grade: 3, active: false, evaluaciones: ["lectura", "lectura"] });
  await sembrar({ id: "ajeno", schoolId: otra, grade: 3, evaluaciones: ["lectura", "lectura", "lectura"] });
});

after(async () => {
  await entorno.cleanup();
  await Promise.all(apps.map(deleteApp));
});

async function sembrar({ id, schoolId, grade, active = true, evaluaciones }) {
  const estudiante = `bq12-${sufijo}-${id}`;
  await entorno.withSecurityRulesDisabled(async (ctx) => {
    const ref = ctx.firestore().collection("students").doc(estudiante);
    await ref.set({ code: id, fullName: id, schoolId, grade, active });
    for (const [i, subject] of evaluaciones.entries()) {
      await ref.collection("evaluations").doc(`${i}`).set({
        subject, type: "inicial", level: "principiante", date: new Date().toISOString(), evaluatedBy: "prueba",
      });
    }
  });
}

async function llamar(metodo, ruta, cuerpo, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/${ruta}`, { method: metodo, headers, body: cuerpo && JSON.stringify(cuerpo) });
  return { estado: res.status, datos: await res.json() };
}

const ruta = (extra = "") => `analytics/assessments-by-grade?schoolId=${escuela}${extra}`;

test("solo el admin puede ver el reporte", async () => {
  const docente = await llamar("GET", ruta(), undefined, tokens.ana);
  assert.strictEqual(docente.estado, 403);
  const sinToken = await llamar("GET", ruta());
  assert.strictEqual(sinToken.estado, 401);
});

test("cuenta las evaluaciones por materia dentro de cada grado", async () => {
  const r = await llamar("GET", ruta(), undefined, tokens.admin);
  assert.strictEqual(r.estado, 200);
  const grado = (n) => r.datos.grades.find((g) => g.grade === n);

  assert.deepStrictEqual(grado(3).counts, { matematicas: 3, lectura: 1 });
  assert.strictEqual(grado(3).mostUsed, "matematicas");
  assert.strictEqual(grado(3).leastUsed, "lectura");
  assert.strictEqual(grado(3).percentages.matematicas, 75);

  assert.deepStrictEqual(grado(4).counts, { matematicas: 1, lectura: 2 });
  assert.strictEqual(grado(4).mostUsed, "lectura");
  assert.strictEqual(grado(4).leastUsed, "matematicas");
  assert.strictEqual(grado(4).percentages.lectura, 66.7);
});

test("un empate no declara una materia más usada", async () => {
  const r = await llamar("GET", ruta(), undefined, tokens.admin);
  const g5 = r.datos.grades.find((g) => g.grade === 5);
  assert.deepStrictEqual(g5.counts, { matematicas: 2, lectura: 2 });
  assert.strictEqual(g5.mostUsed, null);
  assert.strictEqual(g5.leastUsed, null);
});

test("el total suma los tres grados y deja fuera bajas y otras escuelas", async () => {
  const r = await llamar("GET", ruta(), undefined, tokens.admin);
  assert.strictEqual(r.datos.total, 11); // 4 + 3 + 4; la baja (2) y la otra escuela (3) no cuentan
  assert.deepStrictEqual(r.datos.overall.counts, { matematicas: 6, lectura: 5 });
  assert.strictEqual(r.datos.overall.leastUsed, "lectura");
  assert.deepStrictEqual(r.datos.grades.map((g) => g.grade), [3, 4, 5]);
});

test("una escuela sin evaluaciones responde ceros, sin materia ganadora", async () => {
  const r = await llamar("GET", `analytics/assessments-by-grade?schoolId=escuela-vacia-${sufijo}`, undefined, tokens.admin);
  assert.strictEqual(r.estado, 200);
  assert.strictEqual(r.datos.total, 0);
  assert.strictEqual(r.datos.overall.mostUsed, null);
  assert.strictEqual(r.datos.overall.percentages.matematicas, null);
  assert.ok(r.datos.grades.every((g) => g.total === 0));
});