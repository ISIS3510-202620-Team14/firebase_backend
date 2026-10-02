const express = require("express");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");

const MAX_LOTE = 200; // Opens per request (a Firestore transaction handles this comfortably)
const ID_CLIENTE = /^[\w-]{8,64}$/; // Same clientId rule as students: a retry never duplicates

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("app_opens");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

// Real yyyy-MM-dd date (rejects 2026-02-31)
function esFecha(valor) {
    return typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)
        && new Date(`${valor}T00:00:00Z`).toISOString().startsWith(valor);
}

// Monday of the current week in Colombia time (UTC-5, no daylight saving),
// in the same yyyy-MM-dd format the app sends
function lunesActual() {
    const d = new Date(Date.now() - 5 * 60 * 60 * 1000);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

// POST /  { opens: [{ clientId, openedAt, week, platform, appVersion }] }
app.post("/", async (req, res) => {
    const lista = req.body?.opens;
    if (!Array.isArray(lista) || !lista.length || lista.length > MAX_LOTE) throw invalido(["opens"]);

    const invalidos = [];
    lista.forEach((o, i) => {
        if (!ID_CLIENTE.test(String(o?.clientId))) invalidos.push(`opens[${i}].clientId`);
        if (!esFecha(o?.week)) invalidos.push(`opens[${i}].week`);
        if (Number.isNaN(Date.parse(o?.openedAt))) invalidos.push(`opens[${i}].openedAt`);
    });
    if (invalidos.length) throw invalido(invalidos);

    const db = getFirestore();
    const refs = lista.map((o) => coleccion().doc(String(o.clientId)));

    const recibidas = await db.runTransaction(async (tx) => {
        const previas = await tx.getAll(...refs);
        let nuevas = 0;
        previas.forEach((previa, i) => {
            if (previa.exists) {
                // Same clientId from another teacher is not a retry
                if (previa.get("uid") !== req.usuario.uid) throw new ErrorApi(409, "already-exists");
                return; // Retry of an open we already stored: skip it
            }
            const o = lista[i];
            tx.set(refs[i], {
                uid: req.usuario.uid, // always from the verified token, never from the body
                rol: req.usuario.rol,
                schoolId: req.usuario.schoolId ?? null,
                week: o.week,
                openedAt: Timestamp.fromDate(new Date(o.openedAt)),
                platform: String(o.platform || ""),
                appVersion: String(o.appVersion || ""),
                receivedAt: FieldValue.serverTimestamp()
            });
            nuevas++;
        });
        return nuevas;
    });

    res.status(200).json({ received: lista.length, stored: recibidas });
});

// GET /report?week=yyyy-MM-dd  (admin only, defaults to the current week)
app.get("/report", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");

    const week = req.query.week ?? lunesActual();
    if (!esFecha(week)) throw invalido(["week"]);

    // Filters by one field only (no composite index); teachers are filtered in memory
    const snap = await coleccion().where("week", "==", week).get();
    const porDocente = new Map();
    snap.docs
        .filter((d) => d.get("rol") === "docente")
        .forEach((d) => porDocente.set(d.get("uid"), (porDocente.get(d.get("uid")) || 0) + 1));

    const masDeUna = [...porDocente.values()].filter((n) => n > 1).length;
    res.status(200).json({
        week,
        teachers: porDocente.size,
        teachersOverOnce: masDeUna,
        provisional: week === lunesActual()
    });
});

app.use(manejarErrores);
module.exports = app;