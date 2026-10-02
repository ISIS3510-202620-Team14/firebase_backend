const express = require("express");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, puedeVerEscuela, escuelaPedida } = require("../estudiantes/auth");
const { MATERIAS } = require("../estudiantes/niveles");

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("groups");

const MAX_HORAS_DIA = 8; //Horas planeadas de un grupo en un dia

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

// Revisa la forma de los datos de un grupo Con parcial = true (editar) solo mira los campos que vienen.
// Los estudiantes del grupo no se validan aquí: se agregan y quitan con sus propias rutas.
function validarGrupo(body = {}, parcial = false) {
    const datos = {};
    const invalidos = [];

    for (const campo of ["name", "teacherId", "schoolId"]) {
        if (parcial && body[campo] === undefined) continue;
        const valor = body[campo];
        if (typeof valor === "string" && valor.trim()) datos[campo] = valor.trim();
        else invalidos.push(campo);
    }
    if (!(parcial && body.subject === undefined)) {
        if (MATERIAS.includes(body.subject)) datos.subject = body.subject;
        else invalidos.push("subject");
    }
    if (body.campusId !== undefined) {
        if (body.campusId === null) datos.campusId = null;
        else if (typeof body.campusId === "string" && body.campusId.trim()) datos.campusId = body.campusId.trim();
        else invalidos.push("campusId");
    }
    if (body.schedule !== undefined) {
        const horario = horarioDesde(body.schedule);
        if (horario) datos.schedule = horario;
        else invalidos.push("schedule");
    }
    return { datos, invalidos };
}

// Horario semanal: [{ day: 1..7 (lunes = 1), plannedHours }] sin días repetidos. Devuelve null si no sirve.
function horarioDesde(lista) {
    if(!Array.isArray(lista) || lista.length > 7) return null;
    const dias = new Set();
    for (const item of lista) {
        if (!Number.isInteger(item?.day) || item.day < 1 || item.day > 7  || dias.has(item.day)) return null;
        if (typeof item.plannedHours != "number" || !(item.plannedHours > 0) || item.plannedHours > MAX_HORAS_DIA) return null;
        dias.add(item.day);
    }
    return lista.map((item) => ({ day: item.day, plannedHours: item.plannedHours})).sort((a,b) => a.day - b.day);
}

async function validarSede(schoolId, campusId) {
    const escuela = await getFirestore().collection("schools").doc(schoolId).get();
    if (!(escuela.get("campuses") || []).some((s) => s.id === campusId)) {
        throw new ErrorApi(400, "invalid-argument", "Esa sede no pertenece a la escuela del grupo.");
    }
}

// El profesor tiene que ser un docente que trabaje en la escuela del grupo.
async function validarProfesor(teacherId, schoolId) {
    const perfil = await getFirestore().collection("users").doc(teacherId).get();
    const escuelas = perfil.get("schoolIds") || [perfil.get("schoolId")];
    if (!perfil.exists || perfil.get("rol") !== "docente" || !escuelas.includes(schoolId)) {
        throw new ErrorApi(400, "invalid-argument", "El profesor no es un docente de esa escuela.");
    }
}

async function cargarGrupo(req) {
    const doc = await coleccion().doc(req.params.id).get();
    if(!doc.exists || !doc.get("active")) throw new ErrorApi(404, "not-found", "No encontramos ese grupo.");
    if(!puedeVerEscuela(req.usuario, doc.get("schoolId"))) throw new ErrorApi(403, "permission-denied");
    return doc;
}

function aRespuesta(doc) {
    const d = doc.data();
    return {
        id: doc.id,
        name: d.name,
        subject: d.subject,
        teacherId: d.teacherId,
        schoolId: d.schoolId,
        campusId: d.campusId ?? null,
        schedule: d.schedule ?? [],
        studentIds: d.studentIds ?? [],
        createdAt: d.createdAt,
        updatedAt: d.updatedAt
    };
}





//listar
app.get("/", async (req, res) => {
    const { usuario } = req;
    const schoolId = escuelaPedida(usuario, req.query.schoolId);

    let consulta = coleccion().where("active", "==", true);
    if(schoolId) consulta = consulta.where("schoolId", "==", schoolId);
    else if(usuario.rol === "docente") consulta = consulta.where("schoolId", "in", usuario.schoolIds);
    if(req.query.teacherId) consulta = consulta.where("teacherId", "==", req.query.teacherId);
    if(req.query.subject !== undefined) {
        if(!MATERIAS.includes(req.query.subject)) throw invalido(["subject"]);
        consulta = consulta.where("subject", "==", req.query.subject);
    }

    const snap = await consulta.get();
    const groups = snap.docs.map(aRespuesta).sort((a, b) => a.name.localeCompare(b.name, "es"));
    res.status(200).json({ groups });
});





//crear
app.post("/", async (req, res) => {
    const body = { ...req.body };
    body.schoolId = escuelaPedida(req.usuario, body.schoolId);
    // Si el docente no dice quién es el profesor, el grupo queda a su nombre.
    if(req.usuario.rol === "docente" && body.teacherId === undefined) body.teacherId = req.usuario.uid;

    const { datos, invalidos } = validarGrupo(body);
    if(invalidos.length) throw invalido(invalidos);
    await validarProfesor(datos.teacherId, datos.schoolId);
    if (datos.campusId) await validarSede(datos.schoolId, datos.campusId);

    const ahora = new Date().toISOString();
    const ref = coleccion().doc();
    await ref.set({
        campusId: null,
        schedule: [],
        ...datos,
        studentIds: [],
        active: true,
        createdBy: req.usuario.uid,
        createdAt: ahora,
        updatedAt: ahora
    });
    res.status(201).json(aRespuesta(await ref.get()));
});





//detalle: el grupo con el nombre del profesor y los datos básicos de cada niño
app.get("/:id", async (req, res) => {
    const doc = await cargarGrupo(req);
    const db = getFirestore();
    const ids = doc.get("studentIds") || [];

    const [profesor, ...estudiantes] = await db.getAll(
        db.collection("users").doc(doc.get("teacherId")),
        ...ids.map((id) => db.collection("students").doc(id))
    );

    res.status(200).json({
        ...aRespuesta(doc),
        teacher: { id: profesor.id, fullName: profesor.exists ? profesor.get("fullName") : null },
        students: estudiantes
            .filter((e) => e.exists && e.get("active"))
            .map((e) => ({ id: e.id, code: e.get("code"), fullName: e.get("fullName"), grade: e.get("grade") }))
    });
});





//editar
app.patch("/:id", async (req, res) => {
    const doc = await cargarGrupo(req);
    const { datos, invalidos } = validarGrupo(req.body, true);
    if(invalidos.length) throw invalido(invalidos);
    if(!Object.keys(datos).length) throw new ErrorApi(400, "invalid-argument", "No enviaste ningún campo para actualizar.");
    if(datos.schoolId && !puedeVerEscuela(req.usuario, datos.schoolId)) throw new ErrorApi(403, "permission-denied");

    // Con niños adentro, cambiar la materia o la escuela los dejaría en un grupo que no les corresponde.
    const cambiaMateria = datos.subject && datos.subject !== doc.get("subject");
    const cambiaEscuela = datos.schoolId && datos.schoolId !== doc.get("schoolId");
    if((cambiaMateria || cambiaEscuela) && doc.get("studentIds")?.length) {
        throw new ErrorApi(409, "failed-precondition", "Saca a los estudiantes del grupo antes de cambiar su materia o escuela.");
    }

    if(datos.teacherId || cambiaEscuela) {
        await validarProfesor(datos.teacherId || doc.get("teacherId"), datos.schoolId || doc.get("schoolId"));
    }
    // Si cambia la sede o la escuela, la sede (nueva o la que ya tenía) tiene que ser de la escuela final.
    const sede = datos.campusId !== undefined ? datos.campusId : doc.get("campusId");
    if (sede && (datos.campusId !== undefined || cambiaEscuela)) {
        await validarSede(datos.schoolId || doc.get("schoolId"), sede);
    }

    await doc.ref.update({ ...datos, updatedAt: new Date().toISOString() });
    res.status(200).json(aRespuesta(await doc.ref.get()));
});





//eliminar
app.delete("/:id", async (req, res) => {
    const doc = await cargarGrupo(req);
    const ahora = new Date().toISOString();
    await doc.ref.update({ active: false, deletedBy: req.usuario.uid, deletedAt: ahora, updatedAt: ahora });
    res.status(200).json({ id: doc.id, active: false });
});





//agregar estudiante: un niño está en un solo grupo por materia, así que sale de los otros de esa materia
app.post("/:id/students", async (req, res) => {
    const { studentId } = req.body || {};
    if(typeof studentId !== "string" || !studentId.trim()) throw invalido(["studentId"]);

    const doc = await cargarGrupo(req);
    const db = getFirestore();
    const estudianteRef = db.collection("students").doc(studentId.trim());

    const resultado = await db.runTransaction(async (tx) => {
        // En una transacción se lee todo primero y se escribe después.
        const [grupo, estudiante, conElNino] = await Promise.all([
            tx.get(doc.ref),
            tx.get(estudianteRef),
            tx.get(coleccion().where("studentIds", "array-contains", estudianteRef.id))
        ]);

        if(!estudiante.exists || !estudiante.get("active")) throw new ErrorApi(404, "not-found", "No encontramos ese estudiante.");
        if(estudiante.get("schoolId") !== grupo.get("schoolId")) {
            throw new ErrorApi(400, "invalid-argument", "El estudiante no es de la escuela del grupo.");
        }
        if(grupo.get("studentIds").includes(estudianteRef.id)) return { agregado: false, movidoDe: [] };

        const ahora = new Date().toISOString();
        const otros = conElNino.docs.filter((g) => g.id !== grupo.id && g.get("active") && g.get("subject") === grupo.get("subject"));
        for(const otro of otros) {
            tx.update(otro.ref, { studentIds: FieldValue.arrayRemove(estudianteRef.id), updatedAt: ahora });
        }
        tx.update(grupo.ref, { studentIds: FieldValue.arrayUnion(estudianteRef.id), updatedAt: ahora });
        return { agregado: true, movidoDe: otros.map((g) => g.id) };
    });

    res.status(resultado.agregado ? 201 : 200).json({
        ...aRespuesta(await doc.ref.get()),
        movedFrom: resultado.movidoDe
    });
});






//quitar estudiante
app.delete("/:id/students/:studentId", async (req, res) => {
    const doc = await cargarGrupo(req);
    if(!(doc.get("studentIds") || []).includes(req.params.studentId)) {
        throw new ErrorApi(404, "not-found", "Ese estudiante no está en el grupo.");
    }
    await doc.ref.update({ studentIds: FieldValue.arrayRemove(req.params.studentId), updatedAt: new Date().toISOString() });
    res.status(200).json(aRespuesta(await doc.ref.get()));
});

app.use(manejarErrores);
module.exports = app;
