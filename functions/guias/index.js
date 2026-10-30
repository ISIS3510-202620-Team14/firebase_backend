const express = require("express");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");
const { resumir } = require("./resumen");

// BQ tipo 3 de las guías de Ayuda. Las dos apps ya mandan los eventos tutorial_* a la
// colección events con tutorial_id, run_id, step y platform, aquí solo se resumen.

const NOMBRES = ["tutorial_started", "tutorial_completed", "tutorial_abandoned", "tutorial_step_skipped"];
const SEMANAS_POR_DEFECTO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;

const app = express();
app.use(autenticar);

// GET /report?weeks=8  (solo admin)
app.get("/report", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    const semanas = req.query.weeks === undefined ? SEMANAS_POR_DEFECTO : Number(req.query.weeks);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
        throw new ErrorApi(400, "invalid-argument", "Revisa estos campos: weeks.");
    }

    // Un solo filtro en Firestore (sin índice compuesto), la fecha se filtra en memoria
    const desde = Timestamp.fromMillis(Date.now() - semanas * 7 * DIA_MS);
    const snap = await getFirestore().collection("events").where("name", "in", NOMBRES).get();
    const eventos = snap.docs
        .map((d) => d.data())
        .filter((e) => e.createdAt && e.createdAt.toMillis() >= desde.toMillis());

    res.status(200).json({ weeks: semanas, tutorials: resumir(eventos) });
});

app.use(manejarErrores);
module.exports = app;
