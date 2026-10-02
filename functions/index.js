const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp();

const WEB_API_KEY = defineString("WEB_API_KEY");

// Rol con el que nace toda cuenta. Cambiarlo es tarea de un administrador.
const ROL_INICIAL = "docente";

const opciones = { region: "us-central1", cors: true };

// Con el emulador de Auth encendido, Identity Toolkit vive en el host local.
function urlIdentityToolkit(metodo) {
  const emulador = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  const base = emulador
    ? `http://${emulador}/identitytoolkit.googleapis.com/v1`
    : "https://identitytoolkit.googleapis.com/v1";
  return `${base}/accounts:${metodo}?key=${WEB_API_KEY.value()}`;
}

function responder(res, estado, cuerpo) {
  res.status(estado).json(cuerpo);
}

function error(res, estado, code, message) {
  responder(res, estado, { error: { code, message } });
}

// Valida que el cuerpo traiga los campos pedidos, sin mirar su contenido.
function faltantes(body, campos) {
  return campos.filter((c) => typeof body?.[c] !== "string" || !body[c].trim());
}

// Traduce los codigos de Identity Toolkit a los nuestros.
const ERRORES_LOGIN = {
  EMAIL_NOT_FOUND: "invalid-credentials",
  INVALID_PASSWORD: "invalid-credentials",
  INVALID_LOGIN_CREDENTIALS: "invalid-credentials",
  INVALID_EMAIL: "invalid-email",
  USER_DISABLED: "user-disabled",
  TOO_MANY_ATTEMPTS_TRY_LATER: "too-many-requests",
};

const MENSAJES = {
  "invalid-credentials": "Correo o contraseña incorrectos.",
  "invalid-email": "El correo no tiene un formato válido.",
  "user-disabled": "Esta cuenta está deshabilitada.",
  "too-many-requests": "Demasiados intentos. Intenta de nuevo en unos minutos.",
  "email-already-in-use": "Ya existe una cuenta con ese correo.",
  "weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "invalid-argument": "Faltan datos obligatorios.",
  "school-not-found": "La escuela elegida no existe.",
  internal: "No pudimos completar la operación. Intenta de nuevo.",
};

// Escuelas que se pueden elegir al registrarse. Es pública porque aún no hay sesión;
// solo expone id, nombre y municipio.
exports.registerSchools = onRequest(opciones, async (req, res) => {
  if (req.method !== "GET") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  try {
    const todas = await getFirestore().collection("schools").get();
    const schools = todas.docs
      .filter((d) => d.get("active") !== false)
      .map((d) => ({ id: d.id, name: d.get("name") ?? d.id, municipality: d.get("municipality") ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    return responder(res, 200, { schools });
  } catch (e) {
    logger.error(`registerSchools falló: ${e.message}`);
    return error(res, 500, "internal", MENSAJES.internal);
  }
});

// Crea la cuenta en Firebase Auth, su perfil activo con rol inicial y escuela, y devuelve el token.
exports.register = onRequest(opciones, async (req, res) => {
  if (req.method !== "POST") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  const vacios = faltantes(req.body, ["email", "password", "fullName", "schoolId"]);
  if (vacios.length) {
    return error(res, 400, "invalid-argument", `Faltan estos campos: ${vacios.join(", ")}.`);
  }

  const email = req.body.email.trim();
  const fullName = req.body.fullName.trim();
  const schoolId = req.body.schoolId.trim();

  try {
    // Se revisa antes de crear la cuenta para no dejar usuarios sin escuela.
    const escuela = await getFirestore().collection("schools").doc(schoolId).get();
    if (!escuela.exists || escuela.get("active") === false) {
      return error(res, 400, "school-not-found", MENSAJES["school-not-found"]);
    }

    const usuario = await getAuth().createUser({
      email,
      password: req.body.password,
      displayName: fullName,
    });

    const perfil = {
      uid: usuario.uid,
      email,
      fullName,
      rol: ROL_INICIAL,
      activo: true,
      schoolIds: [schoolId],
      createdAt: new Date().toISOString(),
    };
    await getFirestore().collection("users").doc(usuario.uid).set(perfil);

    const customToken = await getAuth().createCustomToken(usuario.uid, { rol: ROL_INICIAL });
    return responder(res, 201, { uid: usuario.uid, rol: ROL_INICIAL, customToken });
  } catch (e) {
    const mapa = {
      "auth/email-already-exists": ["email-already-in-use", 409],
      "auth/invalid-email": ["invalid-email", 400],
      "auth/invalid-password": ["weak-password", 400],
    };
    const [code, estado] = mapa[e.code] || ["internal", 500];
    if (code === "internal") logger.error(`register falló: code=${e.code} message=${e.message}`);
    return error(res, estado, code, MENSAJES[code]);
  }
});

// Verifica correo y contraseña contra Firebase Auth y emite un token para ese uid.
exports.login = onRequest(opciones, async (req, res) => {
  if (req.method !== "POST") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  const vacios = faltantes(req.body, ["email", "password"]);
  if (vacios.length) {
    return error(res, 400, "invalid-argument", `Faltan estos campos: ${vacios.join(", ")}.`);
  }

  let datos;
  try {
    const respuesta = await fetch(urlIdentityToolkit("signInWithPassword"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: req.body.email.trim(),
        password: req.body.password,
        returnSecureToken: false,
      }),
    });
    datos = await respuesta.json();

    if (!respuesta.ok) {
      const code = ERRORES_LOGIN[datos?.error?.message?.split(" ")[0]] || "invalid-credentials";
      return error(res, code === "too-many-requests" ? 429 : 401, code, MENSAJES[code]);
    }
  } catch (e) {
    logger.error("login: no se pudo consultar Identity Toolkit", { name: e.name });
    return error(res, 500, "internal", MENSAJES.internal);
  }

  try {
    const uid = datos.localId;
    const perfilRef = getFirestore().collection("users").doc(uid);
    const perfil = await perfilRef.get();

    // Cuentas creadas antes de este backend pueden no tener perfil todavía.
    if (!perfil.exists) {
      await perfilRef.set({
        uid,
        email: datos.email,
        fullName: datos.displayName || datos.email.split("@")[0],
        rol: ROL_INICIAL,
        activo: true,
        createdAt: new Date().toISOString(),
      });
    }

    // Los perfiles sin el campo se consideran activos; solo false bloquea la entrada.
    if (perfil.exists && perfil.get("activo") === false) {
      return error(res, 403, "user-disabled", MENSAJES["user-disabled"]);
    }

    const rol = perfil.exists ? perfil.get("rol") || ROL_INICIAL : ROL_INICIAL;
    const customToken = await getAuth().createCustomToken(uid, { rol });
    return responder(res, 200, { uid, rol, customToken });
  } catch (e) {
    logger.error("login: no se pudo abrir la sesión", { code: e.code });
    return error(res, 500, "internal", MENSAJES.internal);
  }
});

const estudiantes = require("./estudiantes");

exports.students = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  estudiantes,
);

const appOpens = require("./appOpens");

exports.appOpens = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  appOpens,
);

const grupos = require("./grupos");

exports.groups = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  grupos,
);

const profesores = require("./profesores");

exports.teachers = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  profesores,
);

const instituciones = require("./instituciones");

exports.schools = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  instituciones,
);

const agrupaciones = require("./agrupaciones");

exports.groupings = onRequest(
  { ...opciones, memory: "256MiB", timeoutSeconds: 60, maxInstances: 20 },
  agrupaciones,
);