// BQ #9 (tipo 3): ¿cuánto tarda un docente en clasificar 25 estudiantes?
// La app manda una sesión por cada pasada por la pantalla de Clasificación en la que el docente
// clasificó al menos un estudiante; el reporte normaliza ese tiempo a 25 estudiantes.
const express = require("express");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, escuelaPedida } = require("../estudiantes/auth");
const { MATERIAS } = require("../estudiantes/niveles");

const PLATAFORMAS = ["kotlin", "flutter"];
const ID_CLIENTE = /^[\w-]{8,64}$/; // Mismo clientId que students/appOpens: un reintento nunca duplica
const VERSION_APP = /^[\w.+\- ()]{1,32}$/;
const ESTUDIANTES_OBJETIVO = 25; // La BQ pregunta por 25 estudiantes
const MAX_SEGUNDOS = 4 * 60 * 60; // Una sesión de más de 4 h activas es un error del cliente
const MAX_ESTUDIANTES = 500;
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000; // Relojes de celular adelantados
const SEMANAS_POR_DEFECTO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;
const COLOMBIA_MS = -5 * 60 * 60 * 1000;

const app = express();
app.use(autenticar);

const db = () => getFirestore();
const coleccion = () => db().collection("classificationSessions");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

function soloAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    next();
}

function aMs(valor) {
    if (typeof valor !== "string") return null;
    const ms = Date.parse(valor);
    return Number.isNaN(ms) ? null : ms;
}

// Lunes (yyyy-MM-dd, hora Colombia) de la semana en la que cae ms
function semanaDe(ms) {
    const local = new Date(ms + COLOMBIA_MS);
    const diasDesdeLunes = (local.getUTCDay() + 6) % 7;
    return new Date(local.getTime() - diasDesdeLunes * DIA_MS).toISOString().slice(0, 10);
}

const entero = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

function validarSesion(body = {}) {
    const invalidos = [];
    if (!ID_CLIENTE.test(String(body.clientId))) invalidos.push("clientId");
    if (!MATERIAS.includes(body.subject)) invalidos.push("subject");
    if (!PLATAFORMAS.includes(body.platform)) invalidos.push("platform");
    if (typeof body.appVersion !== "string" || !VERSION_APP.test(body.appVersion.trim())) invalidos.push("appVersion");

    const inicio = aMs(body.startedAt);
    const fin = aMs(body.endedAt);
    if (inicio === null) invalidos.push("startedAt");
    if (fin === null || (inicio !== null && fin < inicio) || fin > Date.now() + TOLERANCIA_FUTURO_MS) invalidos.push("endedAt");

    // El tiempo activo no cuenta lo que la app pasó en segundo plano, así que nunca supera fin - inicio
    const duracion = inicio !== null && fin !== null ? Math.ceil((fin - inicio) / 1000) + 1 : MAX_SEGUNDOS;
    if (!entero(body.activeSeconds, 1, Math.min(MAX_SEGUNDOS, duracion))) invalidos.push("activeSeconds");
    if (!entero(body.studentsClassified, 1, MAX_ESTUDIANTES)) invalidos.push("studentsClassified");
    if (!entero(body.studentsInList, 1, MAX_ESTUDIANTES) || body.studentsInList < body.studentsClassified) {
        invalidos.push("studentsInList");
    }
    if (invalidos.length) throw invalido(invalidos);
    return { inicio, fin };
}

// POST /  { clientId, schoolId, subject, platform, appVersion, startedAt, endedAt,
//           activeSeconds, studentsClassified, studentsInList }
app.post("/", async (req, res) => {
    const body = req.body || {};
    const { inicio, fin } = validarSesion(body);
    const schoolId = escuelaPedida(req.usuario, body.schoolId); // 403 si la escuela no es del docente
    if (typeof schoolId !== "string") throw invalido(["schoolId"]);

    const ref = coleccion().doc(body.clientId);
    const guardada = await db().runTransaction(async (tx) => {
        const previa = await tx.get(ref);
        if (previa.exists) {
            // El mismo clientId de otro docente no es un reintento
            if (previa.get("uid") !== req.usuario.uid) throw new ErrorApi(409, "already-exists");
            return false;
        }
        tx.set(ref, {
            uid: req.usuario.uid, // siempre del token verificado, nunca del cuerpo
            rol: req.usuario.rol,
            schoolId,
            subject: body.subject,
            platform: body.platform,
            appVersion: body.appVersion.trim(),
            startedAt: Timestamp.fromMillis(inicio),
            endedAt: Timestamp.fromMillis(fin),
            week: semanaDe(inicio),
            activeSeconds: body.activeSeconds,
            studentsClassified: body.studentsClassified,
            studentsInList: body.studentsInList,
            secondsPer25: Math.round((body.activeSeconds / body.studentsClassified) * ESTUDIANTES_OBJETIVO),
            receivedAt: FieldValue.serverTimestamp()
        });
        return true;
    });

    res.status(guardada ? 201 : 200).json({ id: body.clientId, stored: guardada });
});

// Minutos por cada 25 estudiantes de un conjunto de sesiones. Se pondera por estudiantes:
// una sesión de 30 estudiantes pesa más que una de 2.
function minutosPor25(sesiones) {
    const segundos = sesiones.reduce((s, d) => s + d.activeSeconds, 0);
    const estudiantes = sesiones.reduce((s, d) => s + d.studentsClassified, 0);
    return Math.round((segundos / estudiantes) * ESTUDIANTES_OBJETIVO / 60 * 10) / 10;
}

const promedio = (valores) => Math.round(valores.reduce((s, v) => s + v, 0) / valores.length * 10) / 10;

// GET /report?schoolId=&subject=&weeks=8  (solo admin)
// Por institución: el promedio de los docentes (cada docente pesa igual) y el detalle de cada uno.
app.get("/report", soloAdmin, async (req, res) => {
    const semanas = req.query.weeks === undefined ? SEMANAS_POR_DEFECTO : Number(req.query.weeks);
    if (!entero(semanas, 1, 52)) throw invalido(["weeks"]);
    const materia = req.query.subject;
    if (materia !== undefined && !MATERIAS.includes(materia)) throw invalido(["subject"]);
    const schoolId = req.query.schoolId;

    // Un solo filtro de rango (sin índice compuesto); escuela, materia y rol se filtran en memoria
    const desde = Timestamp.fromMillis(Date.now() - semanas * 7 * DIA_MS);
    const snap = await coleccion().where("startedAt", ">=", desde).get();
    const sesiones = snap.docs
        .map((d) => d.data())
        .filter((d) => d.rol === "docente")
        .filter((d) => !schoolId || d.schoolId === schoolId)
        .filter((d) => !materia || d.subject === materia);

    const porEscuela = new Map();
    sesiones.forEach((s) => {
        if (!porEscuela.has(s.schoolId)) porEscuela.set(s.schoolId, new Map());
        const porDocente = porEscuela.get(s.schoolId);
        if (!porDocente.has(s.uid)) porDocente.set(s.uid, []);
        porDocente.get(s.uid).push(s);
    });

    const uids = [...new Set(sesiones.map((s) => s.uid))];
    const escuelasIds = [...porEscuela.keys()];
    const [perfiles, escuelas] = await Promise.all([
        uids.length ? db().getAll(...uids.map((id) => db().collection("users").doc(id))) : [],
        escuelasIds.length ? db().getAll(...escuelasIds.map((id) => db().collection("schools").doc(id))) : []
    ]);
    const nombreDocente = new Map(perfiles.map((p) => [p.id, p.get("fullName") ?? null]));
    const nombreEscuela = new Map(escuelas.map((e) => [e.id, e.get("name") ?? e.id]));

    const schools = escuelasIds.map((id) => {
        const teachers = [...porEscuela.get(id)].map(([uid, lista]) => ({
            uid,
            fullName: nombreDocente.get(uid) ?? null,
            sessions: lista.length,
            studentsClassified: lista.reduce((s, d) => s + d.studentsClassified, 0),
            minutesPer25: minutosPor25(lista)
        })).sort((a, b) => a.minutesPer25 - b.minutesPer25);
        return {
            schoolId: id,
            name: nombreEscuela.get(id) ?? id,
            teachers,
            sessions: teachers.reduce((s, t) => s + t.sessions, 0),
            studentsClassified: teachers.reduce((s, t) => s + t.studentsClassified, 0),
            avgMinutesPer25: promedio(teachers.map((t) => t.minutesPer25))
        };
    }).sort((a, b) => a.name.localeCompare(b.name, "es"));

    res.status(200).json({ weeks: semanas, subject: materia ?? null, target: ESTUDIANTES_OBJETIVO, schools });
});

app.use(manejarErrores);
module.exports = app;
