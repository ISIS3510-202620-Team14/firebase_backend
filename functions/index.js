const { onRequest } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { enviarCorreo, BREVO_API_KEY } = require("./correo/brevo");
const { armarBienvenida } = require("./correo/bienvenida");

initializeApp();

const WEB_API_KEY = defineString("WEB_API_KEY");

// Rol con el que nace toda cuenta. Cambiarlo es tarea de un administrador.
const ROL_INICIAL = "docente";

// Un docente puede trabajar en varias escuelas; este es el tope al registrarse.
const MAX_ESCUELAS = 10;

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
  "school-not-found": "Alguna de las escuelas elegidas no existe.",
  "campus-not-found": "Alguna de las sedes elegidas no pertenece a su institución.",
  internal: "No pudimos completar la operación. Intenta de nuevo.",
};

// Escuelas que se pueden elegir al registrarse, con sus sedes. Es pública porque aún no hay sesión;
// solo expone id, nombre, municipio y sedes.
exports.registerSchools = onRequest(opciones, async (req, res) => {
  if (req.method !== "GET") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  try {
    const todas = await getFirestore().collection("schools").get();
    const schools = todas.docs
      .filter((d) => d.get("active") !== false)
      .map((d) => ({
        id: d.id,
        name: d.get("name") ?? d.id,
        municipality: d.get("municipality") ?? null,
        // Las sedes sin id o nombre (cargadas a mano incompletas) no se pueden elegir.
        campuses: (d.get("campuses") || [])
          .filter((c) => textoNoVacio(c?.id) && textoNoVacio(c?.name))
          .map((c) => ({ id: c.id, name: c.name })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, "es"));
    return responder(res, 200, { schools });
  } catch (e) {
    logger.error(`registerSchools falló: ${e.message}`);
    return error(res, 500, "internal", MENSAJES.internal);
  }
});

const textoNoVacio = (v) => typeof v === "string" && v.trim() !== "";

// Escuelas y sedes pedidas en el registro: schools [{ schoolId, campusIds }], o las formas viejas
// schoolIds (lista) / schoolId (una sola) sin sedes. Devuelve [{ schoolId, campusIds }] sin repetidos,
// o null si el formato no sirve.
function escuelasPedidas(body) {
  let lista;
  if (Array.isArray(body?.schools)) {
    lista = body.schools;
  } else {
    const ids = Array.isArray(body?.schoolIds) ? body.schoolIds : [body?.schoolId];
    lista = ids.map((schoolId) => ({ schoolId, campusIds: [] }));
  }

  const porEscuela = new Map();
  for (const item of lista) {
    const campusIds = item?.campusIds ?? [];
    if (!textoNoVacio(item?.schoolId) || !Array.isArray(campusIds) || !campusIds.every(textoNoVacio)) return null;
    const previas = porEscuela.get(item.schoolId.trim()) || [];
    porEscuela.set(item.schoolId.trim(), [...new Set([...previas, ...campusIds.map((c) => c.trim())])]);
  }
  if (!porEscuela.size || porEscuela.size > MAX_ESCUELAS) return null;
  return [...porEscuela].map(([schoolId, campusIds]) => ({ schoolId, campusIds }));
}

// Avisa por correo que la cuenta quedó creada. Devuelve si Brevo lo aceptó; nunca lanza.
function enviarBienvenida(email, fullName, escuelas, pedidas) {
  const instituciones = escuelas.map((escuela, i) => {
    const sedes = escuela.get("campuses") || [];
    return {
      nombre: escuela.get("name") ?? escuela.id,
      sedes: pedidas[i].campusIds.map((id) => sedes.find((c) => c.id === id)?.name ?? id),
    };
  });
  const { asunto, html, texto } = armarBienvenida({ nombre: fullName, instituciones });
  return enviarCorreo({ para: email, nombre: fullName, asunto, html, texto });
}

// Crea la cuenta en Firebase Auth, su perfil activo con rol inicial y escuelas, y devuelve el token.
// Al final envía el correo de bienvenida; si no sale, la cuenta igual queda creada.
exports.register = onRequest({ ...opciones, secrets: [BREVO_API_KEY] }, async (req, res) => {
  if (req.method !== "POST") return error(res, 405, "invalid-argument", MENSAJES["invalid-argument"]);

  const vacios = faltantes(req.body, ["email", "password", "fullName"]);
  const pedidas = escuelasPedidas(req.body);
  if (!pedidas) vacios.push("schools");
  if (vacios.length) {
    return error(res, 400, "invalid-argument", `Faltan estos campos: ${vacios.join(", ")}.`);
  }

  const email = req.body.email.trim();
  const fullName = req.body.fullName.trim();

  let usuario;
  try {
    // Se revisa antes de crear la cuenta para no dejar usuarios sin escuela o con sedes ajenas.
    const escuelas = await getFirestore().getAll(
      ...pedidas.map((p) => getFirestore().collection("schools").doc(p.schoolId)),
    );
    if (escuelas.some((e) => !e.exists || e.get("active") === false)) {
      return error(res, 400, "school-not-found", MENSAJES["school-not-found"]);
    }
    for (const [i, escuela] of escuelas.entries()) {
      const sedes = (escuela.get("campuses") || []).map((c) => c.id);
      const elegidas = pedidas[i].campusIds;
      if (elegidas.some((c) => !sedes.includes(c))) {
        return error(res, 400, "campus-not-found", MENSAJES["campus-not-found"]);
      }
      // Si la institución tiene sedes, el docente dice en cuál(es) trabaja.
      if (sedes.length && !elegidas.length) {
        return error(res, 400, "campus-required", `Elige al menos una sede de ${escuela.get("name") ?? escuela.id}.`);
      }
    }

    usuario = await getAuth().createUser({
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
      schoolIds: pedidas.map((p) => p.schoolId),
      // Sedes por institución: { [schoolId]: [campusId, ...] }.
      campusIds: Object.fromEntries(pedidas.map((p) => [p.schoolId, p.campusIds])),
      createdAt: new Date().toISOString(),
    };
    await getFirestore().collection("users").doc(usuario.uid).set(perfil);

    const customToken = await getAuth().createCustomToken(usuario.uid, { rol: ROL_INICIAL });
    const welcomeEmailSent = await enviarBienvenida(email, fullName, escuelas, pedidas);
    return responder(res, 201, { uid: usuario.uid, rol: ROL_INICIAL, customToken, welcomeEmailSent });
  } catch (e) {
    const mapa = {
      "auth/email-already-exists": ["email-already-in-use", 409],
      "auth/invalid-email": ["invalid-email", 400],
      "auth/invalid-password": ["weak-password", 400],
    };
    const [code, estado] = mapa[e.code] || ["internal", 500];
    if (code === "internal") {
      logger.error(`register falló: code=${e.code} message=${e.message}`);
      // Si la cuenta alcanzó a crearse pero el perfil no, se borra para que el correo quede libre.
      if (usuario) {
        await getAuth().deleteUser(usuario.uid).catch((err) =>
          logger.error(`register: no se pudo deshacer la cuenta ${usuario.uid}: ${err.message}`));
      }
    }
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