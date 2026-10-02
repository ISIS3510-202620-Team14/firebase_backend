// Flujo completo contra los emuladores: escuelas para el registro, registro, credenciales malas, login,
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
  collection,
  addDoc,
  serverTimestamp,
  query,
  where,
  getCountFromServer,
} = require("firebase/firestore");
const { initializeTestEnvironment } = require("@firebase/rules-unit-testing");

const BASE = "http://127.0.0.1:5001/enad-movil/us-central1";
const correo = `ana.${Date.now()}@enad.test`;
const clave = "clave-segura-123";
const escuela = `ie-prueba-${Date.now()}`;
const otraEscuela = `ie-prueba-2-${Date.now()}`;

let app, auth, db, entorno;

// Escribe en Firestore saltándose las reglas, como lo haría un admin desde la consola.
function comoAdmin(cambio) {
  return entorno.withSecurityRulesDisabled((ctx) => cambio(ctx.firestore()));
}

before(async () => {
  app = initializeApp({ projectId: "enad-movil", apiKey: "fake-api-key" });
  auth = getAuth(app);
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  db = getFirestore(app);
  connectFirestoreEmulator(db, "127.0.0.1", 8080);

  entorno = await initializeTestEnvironment({
    projectId: "enad-movil",
    firestore: { host: "127.0.0.1", port: 8080 },
  });
  await comoAdmin(async (fs) => {
    await fs.collection("schools").doc(escuela).set({ name: "IE Prueba", municipality: "Pereira", active: true });
    await fs.collection("schools").doc(otraEscuela).set({
      name: "IE Prueba Dos",
      municipality: "Apía",
      active: true,
      campuses: [{ id: "sede-centro", name: "Sede Centro" }, { id: "sede-rural", name: "Sede Rural" }],
    });
  });
});

after(async () => {
  await entorno.cleanup();
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

test("registerSchools lista las escuelas activas", async () => {
  const res = await fetch(`${BASE}/registerSchools`);
  assert.strictEqual(res.status, 200);
  const { schools } = await res.json();
  assert.ok(schools.some((s) => s.id === escuela && s.name === "IE Prueba"));
  const conSedes = schools.find((s) => s.id === otraEscuela);
  assert.deepStrictEqual(conSedes.campuses.map((c) => c.id), ["sede-centro", "sede-rural"]);
});

test("register rechaza una escuela que no existe", async () => {
  const { estado, datos } = await llamar("register", {
    email: `sin.escuela.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Sin Escuela",
    schoolId: "no-existe",
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "school-not-found");
});

test("register guarda varias instituciones con sus sedes, sin repetir", async () => {
  const { estado, datos } = await llamar("register", {
    email: `varias.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Docente Rural",
    schools: [
      { schoolId: escuela, campusIds: [] },
      { schoolId: otraEscuela, campusIds: ["sede-centro", "sede-rural", "sede-centro"] },
    ],
  });
  assert.strictEqual(estado, 201, JSON.stringify(datos));
  await comoAdmin(async (fs) => {
    const perfil = await fs.collection("users").doc(datos.uid).get();
    assert.deepStrictEqual(perfil.get("schoolIds"), [escuela, otraEscuela]);
    assert.deepStrictEqual(perfil.get("campusIds"), { [escuela]: [], [otraEscuela]: ["sede-centro", "sede-rural"] });
  });
});

test("register pide al menos una sede si la institución tiene sedes", async () => {
  const { estado, datos } = await llamar("register", {
    email: `sinsede.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Sin Sede",
    schools: [{ schoolId: otraEscuela, campusIds: [] }],
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "campus-required");
});

test("register rechaza una sede que no es de esa institución", async () => {
  const { estado, datos } = await llamar("register", {
    email: `sedeajena.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Sede Ajena",
    schools: [{ schoolId: otraEscuela, campusIds: ["sede-de-otro-lado"] }],
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "campus-not-found");
});

test("register rechaza la lista si una de las escuelas no existe", async () => {
  const correoMalo = `mezcla.${Date.now()}@enad.test`;
  const { estado, datos } = await llamar("register", {
    email: correoMalo,
    password: clave,
    fullName: "Mezcla",
    schoolIds: [escuela, "no-existe"],
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "school-not-found");

  // No quedó una cuenta a medias: el correo sigue libre.
  const otra = await llamar("register", { email: correoMalo, password: clave, fullName: "Mezcla", schoolIds: [escuela] });
  assert.strictEqual(otra.estado, 201);
});

test("register sin instituciones crea la cuenta sin escuela (como la app de Kotlin)", async () => {
  const { estado, datos } = await llamar("register", {
    email: `sinescuela.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Sin Escuelas",
  });
  assert.strictEqual(estado, 201, JSON.stringify(datos));
  await comoAdmin(async (fs) => {
    const perfil = await fs.collection("users").doc(datos.uid).get();
    assert.deepStrictEqual(perfil.get("schoolIds"), []);
    assert.strictEqual(perfil.get("rol"), "docente");
  });
});

test("register rechaza escuelas con formato inválido", async () => {
  const { estado, datos } = await llamar("register", {
    email: `malformato.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Mal Formato",
    schools: [{ campusIds: ["sede"] }],
  });
  assert.strictEqual(estado, 400);
  assert.strictEqual(datos.error.code, "invalid-argument");
});

test("register crea la cuenta activa con rol docente", async () => {
  const { estado, datos } = await llamar("register", {
    email: correo,
    password: clave,
    fullName: "Ana Ramírez",
    schoolId: escuela,
  });
  assert.strictEqual(estado, 201);
  assert.strictEqual(datos.rol, "docente");
  assert.ok(datos.customToken);
  // En el emulador no hay clave de Brevo: el correo no sale, pero la cuenta sí se crea.
  assert.strictEqual(datos.welcomeEmailSent, false);
  uid = datos.uid;
});

test("register rechaza un correo ya usado", async () => {
  const { estado, datos } = await llamar("register", {
    email: correo,
    password: clave,
    fullName: "Ana otra vez",
    schoolId: escuela,
  });
  assert.strictEqual(estado, 409);
  assert.strictEqual(datos.error.code, "email-already-in-use");
});

test("register exige todos los campos", async () => {
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
  assert.strictEqual(perfil.data().rol, "docente");
  assert.strictEqual(perfil.data().activo, true);
  assert.deepStrictEqual(perfil.data().schoolIds, [escuela]);
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

test("el usuario no puede cambiar si está activo", async () => {
  await assert.rejects(
    () => updateDoc(doc(db, "users", uid), { activo: false }),
    /permission|PERMISSION_DENIED/i,
  );
});

test("el usuario sí puede corregir su nombre", async () => {
  await updateDoc(doc(db, "users", uid), { fullName: "Ana R." });
  const perfil = await getDoc(doc(db, "users", uid));
  assert.strictEqual(perfil.data().fullName, "Ana R.");
});

test("la BQ cuenta actividades de biblioteca y propias del docente", async () => {
  const eventos = collection(db, "events");
  for (const source of ["library", "custom"]) {
    await addDoc(eventos, {
      teacherId: uid,
      name: "activity_selected",
      source,
      platform: "flutter",
      createdAt: serverTimestamp(),
    });
  }

  const contar = async (source) => {
    const consulta = query(
      eventos,
      where("teacherId", "==", uid),
      where("name", "==", "activity_selected"),
      where("source", "==", source),
    );
    return (await getCountFromServer(consulta)).data().count;
  };

  assert.strictEqual(await contar("library"), 1);
  assert.strictEqual(await contar("custom"), 1);
});

test("el usuario no puede leer el perfil de otro", async () => {
  const otro = await llamar("register", {
    email: `otro.${Date.now()}@enad.test`,
    password: clave,
    fullName: "Otro Docente",
    schoolId: escuela,
  });
  await assert.rejects(
    () => getDoc(doc(db, "users", otro.datos.uid)),
    /permission|PERMISSION_DENIED/i,
  );
});

 test("el usuario no puede cambiar sus colegios", async () => {
  for (const campo of ["schoolId", "schoolIds"]) {
    await assert.rejects(
      () => updateDoc(doc(db, "users", uid), { [campo]: campo === "schoolId" ? "otro" : ["otro"] }),
      /permission|PERMISSION_DENIED/i,
    );
  }
});

test("login rechaza una cuenta desactivada", async () => {
  await comoAdmin((fs) => fs.collection("users").doc(uid).update({ activo: false }));
  const { estado, datos } = await llamar("login", { email: correo, password: clave });
  assert.strictEqual(estado, 403);
  assert.strictEqual(datos.error.code, "user-disabled");
});
