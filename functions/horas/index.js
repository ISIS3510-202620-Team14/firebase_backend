const { createHash } = require("node:crypto");
const express = require("express");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, escuelaPedida } = require("../estudiantes/auth");

const ORIGENES = ["suggested", "manual"];
const PLATAFORMAS = ["kotlin", "flutter"];
const VERSION_APP = /^[\w.+\- ()]{1,32}$/;
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const MAX_HORAS_DIA = 24;
const MAX_MOTIVO = 500;
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000; // Relojes de celular adelantados
const SEMANAS_POR_DEFECTO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;
const COLOMBIA_MS = -5 * 60 * 60 * 1000;

const app = express();
app.use(autenticar);

const db = () => getFirestore();
const coleccion = () => db().collection("workedHours");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

function soloAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    next();
}

const horas = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= MAX_HORAS_DIA;
const hoyColombia = (ms = Date.now()) => new Date(ms + COLOMBIA_MS).toISOString().slice(0, 10);

function fechaValida(texto) {
    if (typeof texto !== "string" || !FECHA.test(texto)) return false;
    const ms = Date.parse(`${texto}T00:00:00Z`);
    return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === texto;
}

// Lunes (yyyy-MM-dd) de la semana de una fecha yyyy-MM-dd
function semanaDe(fecha) {
    const ms = Date.parse(`${fecha}T00:00:00Z`);
    const diasDesdeLunes = (new Date(ms).getUTCDay() + 6) % 7;
    return new Date(ms - diasDesdeLunes * DIA_MS).toISOString().slice(0, 10);
}

function validarReporte(fecha, body = {}) {
    const invalidos = [];
    // Un reporte del futuro es un error del cliente; se deja pasar el día de adelanto por la zona horaria
    if (!fechaValida(fecha) || fecha > hoyColombia(Date.now() + TOLERANCIA_FUTURO_MS)) invalidos.push("date");
    if (!horas(body.plannedHours)) invalidos.push("plannedHours");
    if (!horas(body.workedHours)) invalidos.push("workedHours");
    if (!ORIGENES.includes(body.origin)) invalidos.push("origin");
    if (typeof body.presentAtCampus !== "boolean") invalidos.push("presentAtCampus");
    if (!PLATAFORMAS.includes(body.platform)) invalidos.push("platform");
    if (typeof body.appVersion !== "string" || !VERSION_APP.test(body.appVersion.trim())) invalidos.push("appVersion");

    const guardado = typeof body.savedAt === "string" ? Date.parse(body.savedAt) : NaN;
    if (Number.isNaN(guardado) || guardado > Date.now() + TOLERANCIA_FUTURO_MS) invalidos.push("savedAt");

    // Una sugerencia solo existe si estuvo en la sede, y nunca pasa de lo planeado
    if (body.origin === "suggested" && (body.presentAtCampus !== true || body.workedHours > body.plannedHours)) {
        invalidos.push("origin");
    }

    // Horas realizadas por debajo de lo planeado piden el motivo
    const faltan = horas(body.plannedHours) && horas(body.workedHours) && body.workedHours < body.plannedHours;
    const motivo = typeof body.reason === "string" ? body.reason.trim() : "";
    if (motivo.length > MAX_MOTIVO || (faltan && !motivo)) invalidos.push("reason");

    if (invalidos.length) throw invalido([...new Set(invalidos)]);
    return { guardado, motivo: faltan ? motivo : null };
}

// PUT /:date  { schoolId?, plannedHours, workedHours, origin, reason?, presentAtCampus, savedAt, platform, appVersion }
app.put("/:date", async (req, res) => {
    const body = req.body || {};
    const fecha = req.params.date;
    const { guardado, motivo } = validarReporte(fecha, body);
    const schoolId = escuelaPedida(req.usuario, body.schoolId ?? undefined); // 403 si la escuela no es del docente
    if (typeof schoolId !== "string" || !schoolId.trim()) throw invalido(["schoolId"]);

    const antiguo = coleccion().doc(`${req.usuario.uid}_${fecha}`);
    const identificador = createHash("sha256").update(JSON.stringify([req.usuario.uid, fecha, schoolId])).digest("hex");
    let ref;
    const resultado = await db().runTransaction(async function guardarReporte(tx) {
        const legado = await tx.get(antiguo);
        ref = legado.exists && legado.get("schoolId") === schoolId
            ? antiguo : coleccion().doc(identificador);
        const previo = await tx.get(ref);
        if (previo.exists && previo.get("savedAt").toMillis() >= guardado) {
            const anterior = previo.data();
            const igual = anterior.savedAt.toMillis() === guardado
                && anterior.schoolId === (schoolId ?? null)
                && anterior.plannedHours === body.plannedHours
                && anterior.workedHours === body.workedHours
                && anterior.origin === body.origin
                && anterior.reason === motivo
                && anterior.presentAtCampus === body.presentAtCampus
                && anterior.platform === body.platform
                && anterior.appVersion === body.appVersion.trim();
            return { stored: igual, report: serializarReporte(anterior) };
        }
        const datos = {
            uid: req.usuario.uid, // siempre del token verificado, nunca del cuerpo
            rol: req.usuario.rol,
            schoolId: schoolId ?? null,
            date: fecha,
            week: semanaDe(fecha),
            plannedHours: body.plannedHours,
            workedHours: body.workedHours,
            origin: body.origin,
            reason: motivo,
            presentAtCampus: body.presentAtCampus,
            platform: body.platform,
            appVersion: body.appVersion.trim(),
            savedAt: Timestamp.fromMillis(guardado),
            receivedAt: FieldValue.serverTimestamp()
        };
        tx.set(ref, datos);
        return { stored: true, report: serializarReporte(datos) };
    });

    res.status(200).json({ id: ref.id, ...resultado });
});

function serializarReporte(datos) {
    return {
        date: datos.date,
        schoolId: datos.schoolId,
        plannedHours: datos.plannedHours,
        workedHours: datos.workedHours,
        origin: datos.origin,
        reason: datos.reason,
        presentAtCampus: datos.presentAtCampus,
        savedAt: datos.savedAt.toDate().toISOString(),
        platform: datos.platform,
        appVersion: datos.appVersion,
    };
}

app.get("/", async function consultarPeriodo(req, res) {
    const { from, to } = req.query;
    if (!fechaValida(from) || !fechaValida(to) || from > to
        || Date.parse(to) - Date.parse(from) > 365 * DIA_MS) {
        throw invalido(["from", "to"]);
    }
    const documentos = await coleccion().where("uid", "==", req.usuario.uid).get();
    const reports = [];
    for (const documento of documentos.docs) {
        const fecha = documento.get("date");
        if (fecha >= from && fecha <= to) reports.push(serializarReporte(documento.data()));
    }
    reports.sort(function ordenar(a, b) { return a.date.localeCompare(b.date); });
    res.status(200).json({ reports });
});

const redondear = (v) => Math.round(v * 10) / 10;

// GET /report?schoolId=&weeks=8  (solo admin)
// Por semana: horas planeadas y realizadas, y cuántos días el docente aceptó la sugerencia tal cual
// frente a cuántos los escribió a mano.
app.get("/report", soloAdmin, async (req, res) => {
    const semanas = req.query.weeks === undefined ? SEMANAS_POR_DEFECTO : Number(req.query.weeks);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) throw invalido(["weeks"]);
    const schoolId = req.query.schoolId;

    // Un solo filtro de rango (sin índice compuesto); escuela y rol se filtran en memoria
    const desde = hoyColombia(Date.now() - semanas * 7 * DIA_MS);
    const snap = await coleccion().where("date", ">=", desde).get();
    const reportes = snap.docs
        .map((d) => d.data())
        .filter((d) => d.rol === "docente")
        .filter((d) => !schoolId || d.schoolId === schoolId);

    const porSemana = new Map();
    reportes.forEach((r) => {
        if (!porSemana.has(r.week)) porSemana.set(r.week, []);
        porSemana.get(r.week).push(r);
    });

    const weeks = [...porSemana]
        .map(([week, lista]) => {
            const sugeridos = lista.filter((r) => r.origin === "suggested").length;
            return {
                week,
                days: lista.length,
                teachers: new Set(lista.map((r) => r.uid)).size,
                plannedHours: redondear(lista.reduce((s, r) => s + r.plannedHours, 0)),
                workedHours: redondear(lista.reduce((s, r) => s + r.workedHours, 0)),
                suggested: sugeridos,
                manual: lista.length - sugeridos,
                suggestedShare: redondear((sugeridos / lista.length) * 100),
                withReason: lista.filter((r) => r.reason).length
            };
        })
        .sort((a, b) => a.week.localeCompare(b.week));

    res.status(200).json({ weeks: semanas, schoolId: schoolId ?? null, summary: weeks });
});

app.get("/:date", async function consultarDia(req, res) {
    if (!fechaValida(req.params.date)) throw invalido(["date"]);
    const schoolId = escuelaPedida(req.usuario, req.query.schoolId);
    if (typeof schoolId !== "string" || !schoolId.trim()) throw invalido(["schoolId"]);
    const antiguo = await coleccion().doc(`${req.usuario.uid}_${req.params.date}`).get();
    const identificador = createHash("sha256").update(JSON.stringify([req.usuario.uid, req.params.date, schoolId])).digest("hex");
    const documento = antiguo.exists && antiguo.get("schoolId") === schoolId
        ? antiguo : await coleccion().doc(identificador).get();
    res.status(200).json({ report: documento.exists ? serializarReporte(documento.data()) : null });
});

app.use(manejarErrores);
module.exports = app;
