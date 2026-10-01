const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, escuelaPedida } = require("../estudiantes/auth");
const { MATERIAS } = require("../estudiantes/niveles");

const PLATAFORMAS = ["kotlin", "flutter"];
const CONECTIVIDADES = ["online", "offline"];
const MAX_SALON = 30;
const LIMITE_SYNC_MS = 24 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;
const COLOMBIA_MS = -5 * 60 * 60 * 1000;
const SEMANAS_POR_DEFECTO = 8;
const ID_CLIENTE = /^[\w-]{8,64}$/;
const VERSION_APP = /^[\w.+\- ()]{1,32}$/;
const DIA = /^\d{4}-\d{2}-\d{2}$/;

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("groupingSessions");

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

function semanaDe(ms) {
    const local = new Date(ms + COLOMBIA_MS);
    const diasDesdeLunes = (local.getUTCDay() + 6) % 7;
    return new Date(local.getTime() - diasDesdeLunes * DIA_MS).toISOString().slice(0, 10);
}

function inicioDeSemana(semana) {
    return Date.parse(`${semana}T00:00:00-05:00`);
}

function validarSobre(body) {
    const invalidos = [];
    const sobre = {};

    if (typeof body.clientId === "string" && ID_CLIENTE.test(body.clientId)) sobre.clientId = body.clientId;
    else invalidos.push("clientId");
    if (PLATAFORMAS.includes(body.platform)) sobre.platform = body.platform;
    else invalidos.push("platform");
    if (typeof body.appVersion === "string" && VERSION_APP.test(body.appVersion.trim())) sobre.appVersion = body.appVersion.trim();
    else invalidos.push("appVersion");
    if (CONECTIVIDADES.includes(body.connectivity)) sobre.connectivity = body.connectivity;
    else invalidos.push("connectivity");

    sobre.creadaMs = aMs(body.createdAt);
    sobre.enviadaMs = aMs(body.sentAt);
    if (sobre.creadaMs === null) invalidos.push("createdAt");
    if (sobre.enviadaMs === null) invalidos.push("sentAt");

    if (body.attempt !== undefined && !(Number.isInteger(body.attempt) && body.attempt >= 1)) invalidos.push("attempt");
    sobre.intento = body.attempt ?? null;

    if (invalidos.length) throw invalido(invalidos);
    return sobre;
}

function enteroEntre(valor, min, max) {
    return Number.isInteger(valor) && valor >= min && valor <= max;
}

function validarSesion(body, usuario) {
    const datos = {};
    const invalidos = [];

    if (MATERIAS.includes(body.subject)) datos.subject = body.subject;
    else invalidos.push("subject");

    const nombre = typeof body.groupName === "string" ? body.groupName.trim() : "";
    if (nombre && nombre.length <= 60) datos.groupName = nombre;
    else invalidos.push("groupName");

    if (enteroEntre(body.studentsCounted, 1, MAX_SALON)) datos.studentsCounted = body.studentsCounted;
    else invalidos.push("studentsCounted");
    if (enteroEntre(body.teachersCounted, 1, MAX_SALON)) datos.teachersCounted = body.teachersCounted;
    else invalidos.push("teachersCounted");
    if (enteroEntre(body.studentsAssigned, 0, MAX_SALON)) datos.studentsAssigned = body.studentsAssigned;
    else invalidos.push("studentsAssigned");

    if (invalidos.length) throw invalido(invalidos);

    datos.perGroup = Math.ceil(datos.studentsCounted / datos.teachersCounted);

    datos.schoolId = escuelaPedida(usuario, body.schoolId);
    if (!datos.schoolId) throw invalido(["schoolId"]);
    return datos;
}

function aRespuesta(doc) {
    const d = doc.data();
    return {
        id: doc.id,
        status: d.status,
        week: d.week,
        createdAt: d.createdAt,
        receivedAt: d.receivedAt,
        syncDelayMs: d.syncDelayMs,
        syncedWithin24h: d.syncedWithin24h
    };
}

app.post("/", async (req, res) => {
    const body = req.body || {};
    const sobre = validarSobre(body);
    const recibidaMs = Date.now();

    const desfaseMs = recibidaMs - sobre.enviadaMs;
    const creadaMs = sobre.creadaMs + desfaseMs;
    const demoraMs = Math.max(0, sobre.enviadaMs - sobre.creadaMs);

    let datos = null;
    let fallo = null;
    try {
        datos = validarSesion(body, req.usuario);
    } catch (e) {
        if (!(e instanceof ErrorApi)) throw e;
        fallo = e;
    }

    const base = {
        teacherUid: req.usuario.uid,
        platform: sobre.platform,
        appVersion: sobre.appVersion,
        connectivity: sobre.connectivity,
        deviceCreatedAt: new Date(sobre.creadaMs).toISOString(),
        deviceSentAt: new Date(sobre.enviadaMs).toISOString(),
        receivedAt: new Date(recibidaMs).toISOString(),
        createdAt: new Date(creadaMs).toISOString(),
        week: semanaDe(creadaMs),
        syncDelayMs: demoraMs,
        attempt: sobre.intento
    };

    const ref = coleccion().doc(sobre.clientId);
    const previa = await getFirestore().runTransaction(async (tx) => {
        const doc = await tx.get(ref);
        if (doc.exists) return doc;
        tx.set(ref, fallo
            ? { ...base, status: "error", errorStatus: fallo.estado, errorCode: fallo.code, errorMessage: fallo.message, syncedWithin24h: false }
            : { ...base, ...datos, status: "synced", syncedWithin24h: demoraMs <= LIMITE_SYNC_MS });
        return null;
    });

    if (previa) {
        if (previa.get("teacherUid") !== req.usuario.uid) throw new ErrorApi(409, "already-exists", "Ese clientId ya lo usó otra cuenta.");
        if (previa.get("status") === "error") {
            throw new ErrorApi(previa.get("errorStatus"), previa.get("errorCode"), previa.get("errorMessage"));
        }
        return res.status(200).json(aRespuesta(previa));
    }
    if (fallo) throw fallo;
    res.status(201).json(aRespuesta(await ref.get()));
});

function semanaPedida(valor, campo) {
    if (typeof valor !== "string" || !DIA.test(valor) || Number.isNaN(Date.parse(`${valor}T12:00:00-05:00`))) throw invalido([campo]);
    return semanaDe(Date.parse(`${valor}T12:00:00-05:00`));
}

function porcentaje(parte, total) {
    return total ? Math.round((parte * 1000) / total) / 10 : null;
}

function contar(fila, d) {
    fila.total++;
    if (d.status === "error") fila.errors++;
    else if (d.syncedWithin24h) fila.syncedOnTime++;
    else fila.syncedLate++;
}

function cerrar(fila) {
    const fallidas = fila.syncedLate + fila.errors;
    return { ...fila, notSyncedWithin24h: fallidas, percentage: porcentaje(fallidas, fila.total) };
}

app.get("/report", soloAdmin, async (req, res) => {
    const hoy = semanaDe(Date.now());
    const hasta = req.query.to === undefined ? hoy : semanaPedida(req.query.to, "to");
    const desde = req.query.from === undefined
        ? semanaDe(inicioDeSemana(hasta) - (SEMANAS_POR_DEFECTO - 1) * 7 * DIA_MS + DIA_MS)
        : semanaPedida(req.query.from, "from");
    if (desde > hasta) throw invalido(["from", "to"]);

    const snap = await coleccion().where("week", ">=", desde).where("week", "<=", hasta).get();

    const vacia = () => ({ total: 0, syncedOnTime: 0, syncedLate: 0, errors: 0 });
    const filas = new Map();
    const semanas = new Map();
    for (const doc of snap.docs) {
        const d = doc.data();
        const llave = [d.week, d.platform, d.appVersion, d.connectivity].join("|");
        if (!filas.has(llave)) {
            filas.set(llave, { week: d.week, platform: d.platform, appVersion: d.appVersion, connectivity: d.connectivity, ...vacia() });
        }
        if (!semanas.has(d.week)) semanas.set(d.week, { week: d.week, ...vacia() });
        contar(filas.get(llave), d);
        contar(semanas.get(d.week), d);
    }

    const abierta = (semana) => Date.now() < inicioDeSemana(semana) + 7 * DIA_MS + LIMITE_SYNC_MS;
    const porSemana = (a, b) => b.week.localeCompare(a.week);
    const porFila = (a, b) => porSemana(a, b) || a.platform.localeCompare(b.platform)
        || a.appVersion.localeCompare(b.appVersion) || a.connectivity.localeCompare(b.connectivity);

    res.status(200).json({
        from: desde,
        to: hasta,
        generatedAt: new Date().toISOString(),
        weeks: [...semanas.values()].map((s) => ({ ...cerrar(s), provisional: abierta(s.week) })).sort(porSemana),
        rows: [...filas.values()].map((f) => ({ ...cerrar(f), provisional: abierta(f.week) })).sort(porFila)
    });
});

app.use(manejarErrores);
module.exports = app;
