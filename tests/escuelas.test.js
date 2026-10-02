// Escuelas con id automático y estudiantes que solo pueden pertenecer a una escuela que existe.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const { getAuth, connectAuthEmulator, signInWithCustomToken } = require("firebase/auth");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const sufijo = Date.now();
const escuelaInicial = `ie-base-${sufijo}`;
const clave = "clave-segura-123";

let app, auth, entorno, token;

before(async () => {
  app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" }, "escuelas");
  auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });

  entorno = await initializeTestEnvironment({
    projectId: "enad-movil",
    firestore: { host: "127.0.0.1", port: 8080 },
  });
  await entorno.withSecurityRulesDisabled((ctx) =>
    ctx.firestore().collection("schools").doc(escuelaInicial).set({ name: "IE Base", municipality: "Pereira", active: true }),
  );

  // Un admin: se registra como docente y se sube el rol como lo haría otro admin desde la consola.
  const correo = `admin.${sufijo}@enad.test`;
  const registro = await llamar("POST", "register", { email: correo, password: clave, fullName: "Admin", schoolId: escuelaInicial });
  await entorno.withSecurityRulesDisabled((ctx) =>
    ctx.firestore().collection("users").doc(registro.datos.uid).update({ rol: "admin" }),
  );
  const login = await llamar("POST", "login", { email: correo, password: clave });
  await signInWithCustomToken(auth, login.datos.customToken);
  token = await auth.currentUser.getIdToken();
});

after(async () => {
  await entorno.cleanup();
  await deleteApp(app);
});

async function llamar(metodo, ruta, cuerpo) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/${ruta}`, { method: metodo, headers, body: cuerpo && JSON.stringify(cuerpo) });
  return { estado: res.status, datos: await res.json() };
}

let escuelaNueva;

test("crear una escuela le da un id automático, no uno sacado del nombre", async () => {
  const { estado, datos } = await llamar("POST", "schools", {
    name: `IE Nueva ${sufijo}`,
    department: "Risaralda",
    municipality: "Apía",
  });
  assert.strictEqual(estado, 201);
  assert.ok(!datos.id.includes("ie-nueva"), `id inesperado: ${datos.id}`);
  assert.match(datos.id, /^[A-Za-z0-9]{20}$/);
  escuelaNueva = datos.id;
});

test("no deja crear otra escuela con el mismo nombre en el mismo municipio", async () => {
  const { estado } = await llamar("POST", "schools", {
    name: `IE Nueva ${sufijo}`,
    department: "Risaralda",
    municipality: "Apía",
  });
  assert.strictEqual(estado, 409);
});

test("un estudiante se crea en una escuela que existe", async () => {
  const { estado, datos } = await llamar("POST", "students", {
    code: `E-${sufijo}`,
    fullName: "Luisa Gómez",
    grade: 3,
    schoolId: escuelaNueva,
  });
  assert.strictEqual(estado, 201, JSON.stringify(datos));
  assert.strictEqual(datos.schoolId, escuelaNueva);
});

test("no se puede crear un estudiante en una escuela que no existe", async () => {
  const { estado, datos } = await llamar("POST", "students", {
    code: `F-${sufijo}`,
    fullName: "Sin Escuela",
    grade: 3,
    schoolId: "no-existe",
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "school-not-found");
});

test("no se puede importar una lista a una escuela que no existe", async () => {
  const { estado, datos } = await llamar("POST", "students/import", {
    schoolId: "no-existe",
    students: [{ code: `G-${sufijo}`, fullName: "Otro Niño", grade: 4 }],
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "school-not-found");
});
