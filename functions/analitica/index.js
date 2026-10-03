const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("groupingEvents");

const METODOS_VALIDOS = ["automatic", "manual"];
const MATERIAS = ["matematicas", "lectura"];

app.post("/grouping-events", async (req, res) => {
    const { subject, classSize, method, teacherId, timestamp } = req.body || {};

    if (!MATERIAS.includes(subject)) {
        throw new ErrorApi(400, "invalid-argument", "Materia inválida. Usa 'matematicas' o 'lectura'.");
    }
    if (typeof classSize !== "number" || classSize < 0) {
        throw new ErrorApi(400, "invalid-argument", "classSize debe ser un número positivo.");
    }
    if (!METODOS_VALIDOS.includes(method)) {
        throw new ErrorApi(400, "invalid-argument", "method debe ser 'automatic' o 'manual'.");
    }

    const evento = {
        subject,
        classSize,
        method,
        teacherId: teacherId || req.usuario.uid,
        timestamp: timestamp || new Date().toISOString(),
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