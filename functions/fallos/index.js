const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");
const { resumir } = require("./resumen");

// BQ tipo 1 de fallos de la app. La app guarda en events un "app_session" cada vez que arranca
// y un "app_crash" cuando se cae (lo sube al abrirla de nuevo), aquí solo se resumen.

const NOMBRES = ["app_session", "app_crash"];
const SEMANAS_POR_DEFECTO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;

const app = express();
app.use(autenticar);

function soloAdmin(req) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
}

function semanasPedidas(valor) {
    const semanas = valor === undefined ? SEMANAS_POR_DEFECTO : Number(valor);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
        throw new ErrorApi(400, "invalid-argument", "Revisa estos campos: weeks.");
    }
    return semanas;
}

// GET /report?weeks=8  (solo admin)
app.get("/report", async (req, res) => {
    soloAdmin(req);
    const semanas = semanasPedidas(req.query.weeks);

    // Un solo filtro en Firestore (sin índice compuesto), la fecha se filtra en memoria
    const ahora = Date.now();
    const desde = ahora - semanas * 7 * DIA_MS;
    const snap = await getFirestore().collection("events").where("name", "in", NOMBRES).get();
    const eventos = snap.docs
        .map((d) => {
            const e = d.data();
            return { ...e, createdAtMs: e.createdAt?.toMillis?.() ?? null };
        })
        .filter((e) => e.createdAtMs !== null && e.createdAtMs >= desde);

    res.status(200).json(resumir(eventos, semanas, ahora));
});

app.use(manejarErrores);
module.exports = app;
