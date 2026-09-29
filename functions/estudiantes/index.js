const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("./errores");
const { autenticar, puedeVerEscuela } = require("./auth");
const { NIVELES, MATERIAS, TIPOS_EVALUACION, GRADOS, describirNivel } = require("./niveles");   

const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000; // 5 minutos en milisegundos (Margen´para relojes de celular adelantados)

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("students");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`)
}

function validarEstudiante(body= {}, parcial = false) {
    const datos = {}
    const invalidos = [];

    for (const campo of ["code", "fullName", "schoolId"]) {
        if (parcial && body[campo] === undefined) continue;
        const valor = body[campo];
        if( typeof valor === "string" && valor.trim()) datos[campo] = valor.trim();
        else invalidos.push(campo);
    }
    if (!(parcial && body.grade === undefined)) {
        if (GRADOS.includes(body.grade)) datos.grade = body.grade;
        else invalidos.push("grade");
    }
    return { datos, invalidos};
}

async function codigoOcupado(tx, schoolId, code, excluirId) {
    const snap = await tx.get(
        coleccion().where("schoolId", "==", schoolId).where("code", "==", code).where("active", "==", true).limit(2)
    );
    return snap.docs.some((d) => d.id != excluirId);
}

async function cargarEstudiante(req) {
    const doc = await coleccion().doc(req.params.id).get();
    if(!doc.exists || !doc.get("active")) throw new ErrorApi(404, "not-found");
    if(!puedeVerEscuela(req.usuario, doc.get("schoolId"))) throw new ErrorApi(403, "permission-denied");
    return doc;
}

function aRespuesta(doc) {
    const d = doc.data();
    const levels = Object.fromEntries(
        MATERIAS.map((m) => {
            const actual = d.levels?.[m];
            return [m, actual ? { ...describirNivel(m, actual.level), date: actual.date} : null];
        }),
    );
    return {
        id: doc.id,
        code: d.code,
        fullName: d.fullName, 
        schoolId: d.schoolId,
        grade: d.grade,
        levels, 
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
    };
}

function resumirMateria(materia, evaluaciones) {
    const ultimaDe = (tipo) => evaluaciones.filter((e) => e.type === tipo).at(-1) || null;
    const punto = (e) => e && { ...describirNivel(materia, e.level), date: e.date };
    const base = ultimaDe("inicial");
    const actual = evaluaciones.at(-1) || null;

    return {
        baseline: punto(base),
        midline: punto(ultimaDe("media")),
        endline: punto(ultimaDe("final")),
        current: punto(actual),
        levelsGained: base && actual ? NIVELES[materia].indexOf(actual.level) - NIVELES[materia].indexOf(base.level) : null,
        totalLevels: NIVELES[materia].length,
        history: evaluaciones.map((e) => ({type: e.type, ...punto(e)}))
    };
}

//listar
app.get("/", async (req, res) => {
    const { usuario } = req;
    const schoolId = usuario.rol == "admin" ? req.query.schoolId : usuario.schoolId;

    let consulta = coleccion().where("active", "==", true);
    if(schoolId) consulta = consulta.where("schoolId", "==", schoolId);
    if(req.query.grade) consulta = consulta.where("grade", "==", Number(req.query.grade));

    const snap = await consulta.get();
    const q = (req.query.q || "").trim().toLowerCase();
    const students = snap.docs.map(aRespuesta).filter((e) => !q || e.fullName.toLowerCase().includes(q) || e.code.toLowerCase().includes(q)).sort((a,b) => a.fullName.localeCompare(b.fullName, "es"));
    res.status(200).json({students});
});

//crear
app.post("/", async (req, res) => {
    const body = { ...req.body};
    if(req.usuario.rol === "docente") body.schoolId = req.usuario.schoolId;

    const { datos, invalidos } = validarEstudiante(body);
    if (invalidos.length) throw invalido(invalidos);

    const ahora = new Date().toISOString();
    const ref = coleccion().doc();

    await getFirestore().runTransaction(async (tx) => {
        if(await codigoOcupado(tx, datos.schoolId, datos.code)) throw new ErrorApi(409, "already-exists");
        tx.set(ref, {
            ...datos, active: true, 
            levels: { matematicas: null, lectura: null },
            createdBy: req.usuario.uid,
            createdAt: ahora, 
            updatedAt: ahora
        });
    });
    res.status(201).json(aRespuesta(await ref.get()));
});

//detalle
app.get("/:id", async (req, res) => {
    const doc = await cargarEstudiante(req);
    const escuela = await getFirestore().collection("schools").doc(doc.get("schoolId")).get();

    res.status(200).json({
        ...aRespuesta(doc),
        school: { id: escuela.id, name: escuela.exists ? escuela.get("name") : null}
    });
});

//editar
app.patch("/:id", async (req, res) => {
    const doc = await cargarEstudiante(req);
    const { datos, invalidos} = validarEstudiante(req.body, true);
    if (invalidos.length) throw invalido(invalidos);
    if (!Object.keys(datos).length) throw new ErrorApi(400, "invalid-argument", "No enviaste ningún campo para actualizar.");
    if (datos.schoolId && !puedeVerEscuela(req.usuario, datos.schoolId)) throw new ErrorApi(403, "permission-denied");

    const final = { schoolId: doc.get("schoolId"), code: doc.get("code"), ...datos};

    await getFirestore().runTransaction(async (tx) => {
        const cambiaIdentidad = datos.code || datos.schoolId;
        if(cambiaIdentidad && (await codigoOcupado(tx, final.schoolId, final.code, doc.id))) {
            throw new ErrorApi(409, "already-exists");
        }
        tx.update(doc.ref, { ...datos, updatedAt: new Date().toISOString()});
    });
    res.status(200).json(aRespuesta(await doc.ref.get()));
});

//eliminar
app.delete("/:id", async (req, res) => {
  const doc = await cargarEstudiante(req);
  const ahora = new Date().toISOString();
  await doc.ref.update({ active: false, deletedBy: req.usuario.uid, deletedAt: ahora, updatedAt: ahora });
  res.status(200).json({ id: doc.id, active: false });
});

//registrar nivel
app.post("/:id/evaluations", async (req, res) => {
    const { subject, type, level, date, clientId } = req.body || {};
    const fecha = date === undefined ? new Date() : new Date(date);

    const invalidos = [];
    if(!MATERIAS.includes(subject)) invalidos.push("subject");
    if(!TIPOS_EVALUACION.includes(type)) invalidos.push("type");
    if(!NIVELES[subject]?.includes(level)) invalidos.push("level");
    if(Number.isNaN(fecha.getTime()) || fecha.getTime() > Date.now() + TOLERANCIA_FUTURO_MS) invalidos.push("date");
    if(clientId !== undefined && !/^[\w-]{8,64}$/.test(String(clientId))) invalidos.push("clientId");
    if(invalidos.length) throw invalido(invalidos);

    const doc = await cargarEstudiante(req);
    const evaluaciones = doc.ref.collection("evaluations");
    const ref = clientId ? evaluaciones.doc(clientId) : evaluaciones.doc();
    const evaluacion = { subject, type, level, date: fecha.toISOString(), evaluatedBy: req.usuario.uid, createdAt: new Date().toISOString()};
    
    const creada = await getFirestore().runTransaction(async (tx) => {
        const [estudiante, previa] = await Promise.all([tx.get(doc.ref), tx.get(ref)]);
        if(previa.exists) return false;

        tx.set(ref, evaluacion);

        const vigente = estudiante.get(`levels.${subject}`);
        if(!vigente || evaluacion.date >= vigente.date) {
            tx.update(doc.ref, {
                [`levels.${subject}`]: { level, date: evaluacion.date},
                updatedAt: evaluacion.createdAt,
            });
        }
        return true;
    });
    const guardada = (await ref.get()).data();
    res.status(creada ? 201 : 200).json({ id: ref.id,...guardada, ...describirNivel(subject, guardada.level)});
});

//Progreso general
app.get("/:id/progress", async (req, res) => {
    const doc = await cargarEstudiante(req);
    const [evaluaciones, asistencia] = await Promise.all([
        doc.ref.collection("evaluations").orderBy("date").get(),
        doc.ref.collection("attendance").get()
    ]);

    const todas = evaluaciones.docs.map((d) => d.data());
    const subjects = Object.fromEntries(MATERIAS.map((m) => [m, resumirMateria(m, todas.filter((e) => e.subject === m))]),);
    const presentes = asistencia.docs.filter((d) => d.get("present") === true).length;

    res.status(200).json({
        student: aRespuesta(doc),
        subjects,
        attendance: {
            recorded: asistencia.size,
            present: presentes,
            percentage: asistencia.size ? Math.round((presentes * 100) / asistencia.size) : null
        }
    });
});
app.use(manejarErrores);
module.exports = app;
