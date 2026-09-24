const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();

const WEB_API_KEY = defineString("WEB_API_KEY");

// Rol con el que nace toda cuenta. Subirlo de nivel es tarea de un administrador.
const ROL_INICIAL = "sin_privilegios";

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
  internal: "No pudimos completar la operación. Intenta de nuevo.",
};

// Crea la cuenta en Firebase Auth, su perfil con rol inicial y devuelve el token.
exports.register = onRequest(opciones, async (req, res) => {
  if (req.method !== "POST") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  const vacios = faltantes(req.body, ["email", "password", "fullName"]);
  if (vacios.length) {
    return error(res, 400, "invalid-argument", `Faltan estos campos: ${vacios.join(", ")}.`);
  }

  const email = req.body.email.trim();
  const fullName = req.body.fullName.trim();

  try {
    const usuario = await admin.auth().createUser({
      email,
      password: req.body.password,
      displayName: fullName,
    });

    const perfil = {
      uid: usuario.uid,
      email,
      fullName,
      rol: ROL_INICIAL,
      createdAt: new Date().toISOString(),
    };
    await admin.firestore().collection("users").doc(usuario.uid).set(perfil);

    const customToken = await admin.auth().createCustomToken(usuario.uid, { rol: ROL_INICIAL });
    return responder(res, 201, { uid: usuario.uid, rol: ROL_INICIAL, customToken });
  } catch (e) {
    const mapa = {
      "auth/email-already-exists": ["email-already-in-use", 409],
      "auth/invalid-email": ["invalid-email", 400],
      "auth/invalid-password": ["weak-password", 400],
    };
    const [code, estado] = mapa[e.code] || ["internal", 500];
    if (code === "internal") logger.error("register falló", { code: e.code });
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

  const uid = datos.localId;
  const perfilRef = admin.firestore().collection("users").doc(uid);
  const perfil = await perfilRef.get();

  // Cuentas creadas antes de este backend pueden no tener perfil todavía.
  if (!perfil.exists) {
    await perfilRef.set({
      uid,
      email: datos.email,
      fullName: datos.displayName || datos.email.split("@")[0],
      rol: ROL_INICIAL,
      createdAt: new Date().toISOString(),
    });
  }

  const rol = perfil.get("rol") || ROL_INICIAL;
  const customToken = await admin.auth().createCustomToken(uid, { rol });
  return responder(res, 200, { uid, rol, customToken });
});
