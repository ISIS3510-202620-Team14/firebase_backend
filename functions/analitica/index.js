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

// BQ #10 (Type 3): ¿las páginas escaneadas con buena luz y el celular quieto se leen mejor?
// La app guarda un evento scan_page por página con las condiciones de la foto y lo que leyó el OCR.
const NIVELES_LUZ = ["dark", "low", "good", "glare", "unknown"];
const SEMANAS_ESCANEO = 8;
const MAX_EVENTOS_ESCANEO = 5000;
const DIA_MS = 24 * 60 * 60 * 1000;

const porcentaje = (parte, total) => (total ? Math.round((parte * 1000) / total) / 10 : null);

// Una página no se pudo usar si el OCR falló o no encontró ninguna fila
const fallida = (p) => p.ocrFailed || p.rows === 0;

function resumir(clave, paginas) {
    const filas = paginas.reduce((s, p) => s + p.rows, 0);
    return {
        key: clave,
        pages: paginas.length,
        avgRows: paginas.length ? Math.round((filas * 10) / paginas.length) / 10 : null,
        failureRate: porcentaje(paginas.filter(fallida).length, paginas.length),
    };
}

// Agrupa en el orden de [claves]; las claves sin páginas también salen, con pages = 0
function agrupar(paginas, claves, claveDe) {
    return claves.map((clave) => resumir(clave, paginas.filter((p) => claveDe(p) === clave)));
}

// Los eventos los escribe el celular: cualquier campo raro se normaliza en vez de romper el reporte
function aPagina(d) {
    const rows = Number.isInteger(d.rows) && d.rows >= 0 ? d.rows : 0;
    return {
        teacherId: d.teacherId,
        lightLevel: NIVELES_LUZ.includes(d.lightLevel) ? d.lightLevel : "unknown",
        steady: typeof d.steady === "boolean" ? d.steady : null,
        torch: d.torch === true,
        autoCapture: d.autoCapture === true,
        ocrFailed: d.ocrFailed === true,
        rows,
    };
}

// GET /scan-quality?weeks=8  (solo admin)
app.get("/scan-quality", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    const semanas = req.query.weeks === undefined ? SEMANAS_ESCANEO : Number(req.query.weeks);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
        throw new ErrorApi(400, "invalid-argument", "weeks debe ser un entero entre 1 y 52.");
    }

    // Un solo filtro de igualdad (sin índice compuesto); la fecha se filtra en memoria
    const desde = Date.now() - semanas * 7 * DIA_MS;
    const snap = await getFirestore()
        .collection("events")
        .where("name", "==", "scan_page")
        .limit(MAX_EVENTOS_ESCANEO)
        .get();
    const paginas = snap.docs
        .map((doc) => doc.data())
        .filter((d) => d.createdAt?.toMillis?.() >= desde)
        .map(aPagina);

    // "Listo" es lo que el asistente le pide al docente: buena luz y el celular quieto
    const lista = (p) => p.lightLevel === "good" && p.steady === true;
    const docentes = new Set(paginas.map((p) => p.teacherId));
    const conAutomatica = new Set(paginas.filter((p) => p.autoCapture).map((p) => p.teacherId));

    res.status(200).json({
        weeks: semanas,
        pages: paginas.length,
        teachers: docentes.size,
        ready: agrupar(paginas, ["ready", "not_ready"], (p) => (lista(p) ? "ready" : "not_ready")),
        light: agrupar(paginas, NIVELES_LUZ, (p) => p.lightLevel),
        steadiness: agrupar(paginas, ["steady", "moving", "unknown"],
            (p) => (p.steady === null ? "unknown" : p.steady ? "steady" : "moving")),
        torch: agrupar(paginas, ["on", "off"], (p) => (p.torch ? "on" : "off")),
        capture: agrupar(paginas, ["auto", "manual"], (p) => (p.autoCapture ? "auto" : "manual")),
        autoCapture: {
            pagesShare: porcentaje(paginas.filter((p) => p.autoCapture).length, paginas.length),
            teachers: conAutomatica.size,
            teachersShare: porcentaje(conAutomatica.size, docentes.size),
        },
    });
});

app.use(manejarErrores);
module.exports = app;