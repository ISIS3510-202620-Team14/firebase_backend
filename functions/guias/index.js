const express = require("express");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");
const { resumir, seleccionar } = require("./resumen");

// BQ tipo 3 de las guías de Ayuda. Las dos apps ya mandan los eventos tutorial_* a la
// colección events con tutorial_id, run_id, step y platform, aquí solo se resumen.

const NOMBRES = ["tutorial_started", "tutorial_completed", "tutorial_abandoned", "tutorial_step_skipped"];
const SEMANAS_POR_DEFECTO = 8;
const DIA_MS = 24 * 60 * 60 * 1000;

const app = express();
app.use(autenticar);

/** Reads one platform and guide version so step numbers remain comparable. */
app.get("/report", async function (req, res) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    const semanas = req.query.weeks === undefined ? SEMANAS_POR_DEFECTO : Number(req.query.weeks);
    const platform = req.query.platform === undefined ? "kotlin" : req.query.platform;
    const version = req.query.version === undefined ? 2 : Number(req.query.version);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52 ||
        !["kotlin", "flutter"].includes(platform) || !Number.isInteger(version) || version < 1) {
        throw new ErrorApi(400, "invalid-argument", "Revisa weeks, platform y version.");
    }
    const desde = Timestamp.fromMillis(Date.now() - semanas * 7 * DIA_MS);
    // # micro opt
    // Read only guide events in this time window, in bounded pages.
    const query = getFirestore().collection("events")
        .where("name", "in", NOMBRES)
        .where("createdAt", ">=", desde).orderBy("createdAt").limit(500);
    const eventos = [];
    let cursor;
    while (true) {
        const snap = await (cursor ? query.startAfter(cursor) : query).get();
        for (const doc of snap.docs) {
            const event = doc.data();
            if (NOMBRES.includes(event.name)) eventos.push(event);
        }
        if (snap.size < 500) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    const selected = seleccionar(eventos, platform, version);
    res.status(200).json({ weeks: semanas, platform, version,
        excluded: eventos.length - selected.length, tutorials: resumir(selected) });
});

app.use(manejarErrores);
module.exports = app;
