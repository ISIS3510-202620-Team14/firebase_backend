const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("groupingEvents");

const METODOS_VALIDOS = ["automatic", "manual"];
const MATERIAS = ["matematicas", "lectura"];
const MAX_ESTUDIANTES = 500; // Mismo tope que las sesiones de clasificación
const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000; // Relojes de celular adelantados

// POST /grouping-events  { subject, classSize, method, timestamp? }
// El docente sale siempre del token verificado: un evento nunca se registra a nombre de otro.
app.post("/grouping-events", async (req, res) => {
    const { subject, classSize, method, timestamp } = req.body || {};

    if (!MATERIAS.includes(subject)) {
        throw new ErrorApi(400, "invalid-argument", "Materia inválida. Usa 'matematicas' o 'lectura'.");
    }
    if (!Number.isInteger(classSize) || classSize < 0 || classSize > MAX_ESTUDIANTES) {
        throw new ErrorApi(400, "invalid-argument", `classSize debe ser un entero entre 0 y ${MAX_ESTUDIANTES}.`);
    }
    if (!METODOS_VALIDOS.includes(method)) {
        throw new ErrorApi(400, "invalid-argument", "method debe ser 'automatic' o 'manual'.");
    }

    // La hora en que el docente armó el grupo (puede ser anterior si la app estaba sin conexión).
    let momento = new Date();
    if (timestamp !== undefined) {
        momento = typeof timestamp === "string" ? new Date(timestamp) : new Date(NaN);
        if (Number.isNaN(momento.getTime()) || momento.getTime() > Date.now() + TOLERANCIA_FUTURO_MS) {
            throw new ErrorApi(400, "invalid-argument", "timestamp debe ser una fecha válida que no sea futura.");
        }
    }

    const evento = {
        subject,
        classSize,
        method,
        teacherId: req.usuario.uid,
        timestamp: momento.toISOString(),
        createdAt: new Date().toISOString(),
        createdBy: req.usuario.uid,
    };

    const ref = coleccion().doc();
    await ref.set(evento);

    res.status(201).json({ id: ref.id, ...evento });
});

app.get("/grouping-events", async (req, res) => {
    let consulta = coleccion().orderBy("createdAt", "desc").limit(200);

    if (req.query.subject) {
        if (!MATERIAS.includes(req.query.subject)) {
            throw new ErrorApi(400, "invalid-argument", "Materia inválida.");
        }
        consulta = consulta.where("subject", "==", req.query.subject);
    }

    const snap = await consulta.get();
    const events = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    res.status(200).json({ events });
});

// BQ #11 (Type 4): Top activity.
app.get("/top-activities", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");

    const snap = await getFirestore()
        .collection("events")
        .where("name", "==", "activity_selected")
        .limit(2000)
        .get();

    const porTitulo = new Map();
    snap.docs.forEach((doc) => {
        const d = doc.data();
        const titulo = d.title || "Actividad sin título";
        const fila = porTitulo.get(titulo) || { title: titulo, subject: d.subject || null, count: 0 };
        fila.count++;
        porTitulo.set(titulo, fila);
    });

    const total = snap.size;
    const activities = [...porTitulo.values()]
        .sort((a, b) => b.count - a.count)
        .map((fila) => ({ ...fila, percentage: total ? Math.round((fila.count * 1000) / total) / 10 : null }));

    res.status(200).json({ total, activities });
});

app.use(manejarErrores);
module.exports = app;