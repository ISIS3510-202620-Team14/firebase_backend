const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");
const { exportAnalytics } = require("./export");
const { MATERIAS: MATERIAS_ENAD, GRADOS} = require("../estudiantes/niveles")

const app = express();
app.use(autenticar);

/** Returns manual aggregate data for Sheets and Looker. */
app.get("/export", async function exportReport(req, res) {
    await exportAnalytics(req, res, getFirestore());
});

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

//bq # 12
const MAX_EVALUACIONES = 20000;
const redondear = (n) => Math.round(n* 10) / 10;

function resumirConteo(conteo) {
    const [a, b] = MATERIAS_ENAD;
    const total = conteo[a] + conteo[b];
    const masUsada = conteo[a] === conteo[b] ? null : conteo[a] > conteo[b] ? a : b;
    return {
        total,
        counts: { [a]: conteo[a], [b]: conteo[b]},
        percentages: { [a]: total ? redondear((conteo[a] * 100) / total) : null, [b]: total ? redondear((conteo[b] * 100) / total) : null},
        mostUsed: total ? masUsada : null,
        leastUsed: total && masUsada ? (masUsada === a ? b : a) : null
    };
}

app.get("/assessments-by-grade", async (req, res) => {
    if (req.usuario.rol != "admin") throw new ErrorApi(403, "permission-denied");

    const db = getFirestore();
    let estudiantes = db.collection("students").where("active", "==", true);
    if (req.query.schoolId) estudiantes = estudiantes.where("schoolId", "==", String(req.query.schoolId));

    const [alumnos, evaluaciones] = await Promise.all([
        estudiantes.get(),
        db.collectionGroup("evaluations").limit(MAX_EVALUACIONES).get()
    ]);
    const gradoDe = new Map(alumnos.docs.map((d) => [d.id, d.get("grade")]));

    const vacio = () => Object.fromEntries(MATERIAS_ENAD.map((m) => [m, 0]));
    const porGrado = new Map(GRADOS.map((g) => [g, vacio()]));
    const global = vacio();
    evaluaciones.docs.forEach((doc) => {
        const estudiante = doc.ref.parent.parent;
        if (estudiante?.parent.id !== "students") return;
        const grado = gradoDe.get(estudiante.id);
        const materia = doc.get("subject");
        if (!porGrado.has(grado) || !MATERIAS_ENAD.includes(materia)) return;
        porGrado.get(grado)[materia]++;
        global[materia]++;
    });

    const overall = resumirConteo(global);
    const grades = GRADOS.map((grade) => ({ grade, ...resumirConteo(porGrado.get(grade))}));
    res.status(200).json({ total: overall.total, overall, grades});
})


// BQ #11 (Type 3): ¿qué tanto corrige el docente lo que leyó el escáner antes de importar?
// Al importar, la app guarda un evento scan_review con conteos (nunca nombres ni códigos).
const SEMANAS_REVISION = 8;
const MAX_EVENTOS_REVISION = 5000;
const MS_POR_DIA_REVISION = 24 * 60 * 60 * 1000;
const ORIGENES_REVISION = ["attendance", "manage_students"];

const cuota = (parte, total) => (total ? redondear((parte * 100) / total) : null);

// Los eventos los escribe el celular: un conteo raro cuenta como 0 y nada supera las filas leídas
function aRevision(d) {
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : 0);
    const leidas = n(d.rowsRead);
    const tope = (v) => Math.min(n(v), leidas);
    return {
        teacherId: d.teacherId,
        source: ORIGENES_REVISION.includes(d.source) ? d.source : "attendance",
        leidas,
        sinCambios: tope(d.rowsUnchanged),
        editadas: tope(d.rowsEdited),
        nombres: tope(d.namesEdited),
        codigos: tope(d.codesEdited),
        borradas: tope(d.rowsDeleted),
    };
}

function resumirRevisiones(revisiones) {
    const suma = (campo) => revisiones.reduce((s, r) => s + r[campo], 0);
    const leidas = suma("leidas");
    return {
        imports: revisiones.length,
        rowsRead: leidas,
        unchanged: { rows: suma("sinCambios"), share: cuota(suma("sinCambios"), leidas) },
        edited: { rows: suma("editadas"), share: cuota(suma("editadas"), leidas) },
        deleted: { rows: suma("borradas"), share: cuota(suma("borradas"), leidas) },
        fields: [
            { key: "name", rows: suma("nombres"), share: cuota(suma("nombres"), leidas) },
            { key: "code", rows: suma("codigos"), share: cuota(suma("codigos"), leidas) },
        ],
    };
}

// GET /scan-review?weeks=8  (solo admin)
app.get("/scan-review", async (req, res) => {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    const semanas = req.query.weeks === undefined ? SEMANAS_REVISION : Number(req.query.weeks);
    if (!Number.isInteger(semanas) || semanas < 1 || semanas > 52) {
        throw new ErrorApi(400, "invalid-argument", "weeks debe ser un entero entre 1 y 52.");
    }

    // Un solo filtro de igualdad (sin índice compuesto); la fecha se filtra en memoria
    const desde = Date.now() - semanas * 7 * MS_POR_DIA_REVISION;
    const snap = await getFirestore()
        .collection("events")
        .where("name", "==", "scan_review")
        .limit(MAX_EVENTOS_REVISION)
        .get();
    const revisiones = snap.docs
        .map((doc) => doc.data())
        .filter((d) => d.createdAt?.toMillis?.() >= desde)
        .map(aRevision);

    const total = resumirRevisiones(revisiones);
    // El campo que más se corrige es la respuesta directa de la BQ; null si no hay correcciones o empatan
    const [nombre, codigo] = total.fields;
    const masCorregido = nombre.rows === codigo.rows ? null : nombre.rows > codigo.rows ? "name" : "code";

    res.status(200).json({
        weeks: semanas,
        teachers: new Set(revisiones.map((r) => r.teacherId)).size,
        ...total,
        mostCorrected: masCorregido,
        bySource: ORIGENES_REVISION.map((origen) => ({
            key: origen,
            ...resumirRevisiones(revisiones.filter((r) => r.source === origen)),
        })),
    });
});

app.use(manejarErrores);
module.exports = app;
