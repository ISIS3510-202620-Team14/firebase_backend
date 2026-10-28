const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");

// BQ Sprint 3 (Type 1): attendance marks that were not applied because another device had
// already recorded a different value for the same student and day. The app writes one
// "attendance_sync" event per school, week and connectivity in the events collection.

const app = express();
app.use(autenticar);

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

// Real yyyy-MM-dd date (rejects 2026-02-31)
function esFecha(valor) {
    return typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)
        && new Date(`${valor}T00:00:00Z`).toISOString().startsWith(valor);
}

// Monday of the current week in Colombia time (UTC-5, no daylight saving)
function lunesActual() {
    const d = new Date(Date.now() - 5 * 60 * 60 * 1000);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

const porcentaje = (parte, total) => (total ? Math.round((parte * 1000) / total) / 10 : null);

// Adds the sent/conflict counts of each event to the row of its key
function agrupar(eventos, clave) {
    const filas = new Map();
    eventos.forEach((e) => {
        const k = clave(e) ?? "unknown";
        const fila = filas.get(k) || { key: k, total: 0, conflicts: 0 };
        fila.total += e.sent + e.conflicts;
        fila.conflicts += e.conflicts;
        filas.set(k, fila);
    });
    return [...filas.values()]
        .map((f) => ({ ...f, percentage: porcentaje(f.conflicts, f.total) }))
        .sort((a, b) => b.conflicts - a.conflicts || b.total - a.total);
}

const conteo = (valor) => (Number.isInteger(valor) && valor > 0 ? valor : 0);

// GET /report?week=yyyy-MM-dd  (admin only, defaults to the current week)
app.get("/report", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");

    const week = req.query.week ?? lunesActual();
    if (!esFecha(week)) throw invalido(["week"]);

    // Equality filters only, so no composite index is needed
    const snap = await getFirestore()
        .collection("events")
        .where("name", "==", "attendance_sync")
        .where("week", "==", week)
        .get();

    const eventos = snap.docs.map((doc) => {
        const d = doc.data();
        return {
            schoolId: d.schoolId || null,
            connectivity: d.connectivity || null,
            platform: d.platform || null,
            sent: conteo(d.sent),
            conflicts: conteo(d.conflicts),
        };
    });

    const ids = [...new Set(eventos.map((e) => e.schoolId).filter(Boolean))];
    const escuelas = ids.length
        ? await getFirestore().getAll(...ids.map((id) => getFirestore().collection("schools").doc(id)))
        : [];
    const nombres = new Map(escuelas.map((d) => [d.id, d.exists ? d.get("name") ?? d.id : d.id]));

    const conflicts = eventos.reduce((n, e) => n + e.conflicts, 0);
    const total = eventos.reduce((n, e) => n + e.sent + e.conflicts, 0);

    res.status(200).json({
        week,
        total,
        conflicts,
        percentage: porcentaje(conflicts, total),
        bySchool: agrupar(eventos, (e) => e.schoolId)
            .map(({ key, ...f }) => ({ schoolId: key, name: nombres.get(key) ?? key, ...f })),
        byConnectivity: agrupar(eventos, (e) => e.connectivity)
            .map(({ key, ...f }) => ({ connectivity: key, ...f })),
        byPlatform: agrupar(eventos, (e) => e.platform)
            .map(({ key, ...f }) => ({ platform: key, ...f })),
        provisional: week === lunesActual(),
    });
});

app.use(manejarErrores);
module.exports = app;
