// Flujo completo contra los emuladores: registro, credenciales malas, login,
// sesión con custom token, logout, reapertura y lectura del propio perfil.
const { test, before, after } = require("node:test");
const assert = require("node:assert");
const { initializeApp, deleteApp } = require("firebase/app");
const {
  getAuth,
  connectAuthEmulator,
  signInWithCustomToken,
  signOut,
} = require("firebase/auth");
const {
  getFirestore,
  connectFirestoreEmulator,
  doc,
  getDoc,
  updateDoc,
} = require("firebase/firestore");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const correo = `ana.${Date.now()}@enad.test`;
const clave = "clave-segura-123";

let app, auth, db;

before(() => {
  app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" });
  auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
});

after(async () => {
  await deleteApp(app);
});

async function llamar(ruta, cuerpo) {
  const res = await fetch(`${BASE}/${ruta}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  return { estado: res.status, datos: await res.json() };
}

let uid;

test("register crea la cuenta con rol sin privilegios", async () => {
  const { estado, datos } = await llamar("register", {
    email: correo,
    password: clave,
    fullName: "Ana Ramírez",
  });
  assert.strictEqual(estado, 201);
  assert.strictEqual(datos.rol, "sin_privilegios");
  assert.ok(datos.customToken);
  uid = datos.uid;
});

test("register rechaza un correo ya usado", async () => {
  const { estado, datos } = await llamar("register", {
    email: correo,
    password: clave,
    fullName: "Ana otra vez",
  });
  assert.strictEqual(estado, 409);
  assert.strictEqual(datos.error.code, "email-already-in-use");
});

test("register exige los tres campos", async () => {
  const { estado, datos } = await llamar("register", { email: correo });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "invalid-argument");
});

test("login rechaza la contraseña incorrecta", async () => {
  const { estado, datos } = await llamar("login", {
    email: correo,
    password: "no-es-la-clave",
  });
  assert.strictEqual(estado, 401);
  assert.strictEqual(datos.error.code, "invalid-credentials");
});

test("login rechaza un correo inexistente", async () => {
  const { estado, datos } = await llamar("login", {
    email: "nadie@enad.test",
    password: clave,
  });
  assert.strictEqual(estado, 401);
  assert.strictEqual(datos.error.code, "invalid-credentials");
});

test("login devuelve un token que abre la sesión y deja leer el perfil", async () => {
  const { estado, datos } = await llamar("login", { email: correo, password: clave });
  assert.strictEqual(estado, 200);
  assert.strictEqual(datos.uid, uid);

  const credencial = await signInWithCustomToken(auth, datos.customToken);
  assert.strictEqual(credencial.user.uid, uid);

  const perfil = await getDoc(doc(db, "users", uid));
  assert.strictEqual(perfil.data().fullName, "Ana Ramírez");
  assert.strictEqual(perfil.data().rol, "sin_privilegios");
});

test("logout y reapertura devuelven el mismo perfil", async () => {
  await signOut(auth);
  assert.strictEqual(auth.currentUser, null);

  const { datos } = await llamar("login", { email: correo, password: clave });
  await signInWithCustomToken(auth, datos.customToken);
  assert.strictEqual(auth.currentUser.uid, uid);

  const perfil = await getDoc(doc(db, "users", uid));
  assert.strictEqual(perfil.data().email, correo);
});

test("el usuario no puede subirse el rol", async () => {
  await assert.rejects(
    () => updateDoc(doc(db, "users", uid), { rol: "admin" }),
    /permission|PERMISSION_DENIED/i,
  );
});

test("el usuario sí puede corregir su nombre", async () => {
  await updateDoc(doc(db, "users", uid), { fullName: "Ana R." });
  const perfil = await getDoc(doc(db, "users", uid));
  assert.strictEqual(perfil.data().fullName, "Ana R.");
});

test("el usuario no puede leer el perfil de otro", async () => {
  const otro = await llamar("register", {
    email: `otro.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Otro Docente",
  });
  await assert.rejects(
    () => getDoc(doc(db, "users", otro.datos.uid)),
    /permission|PERMISSION_DENIED/i,
  );
});
