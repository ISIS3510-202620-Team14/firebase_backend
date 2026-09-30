const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, escuelaPedida } = require("../estudiantes/auth");
const { MATERIAS } = require("../estudiantes/niveles");

const app = express();
app.use(autenticar);

const coleccion = () => getFirestore().collection("groups");

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
    return { datos, invalidos };
}

// El profesor tiene que ser un docente que trabaje en la escuela del grupo.
async function validarProfesor(teacherId, schoolId) {
    const perfil = await getFirestore().collection("users").doc(teacherId).get();
    const escuelas = perfil.get("schoolIds") || [perfil.get("schoolId")];
    if (!perfil.exists || perfil.get("rol") !== "docente" || !escuelas.includes(schoolId)) {
        throw new ErrorApi(400, "invalid-argument", "El profesor no es un docente de esa escuela.");
    }
}

function aRespuesta(doc) {
    const d = doc.data();
    return {
        id: doc.id,
        name: d.name,
        subject: d.subject,
        teacherId: d.teacherId,
        schoolId: d.schoolId,
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

    const ahora = new Date().toISOString();
    const ref = coleccion().doc();
    await ref.set({
        ...datos,
        studentIds: [],
        active: true,
        createdBy: req.usuario.uid,
        createdAt: ahora,
        updatedAt: ahora
    });
    res.status(201).json(aRespuesta(await ref.get()));
});

app.use(manejarErrores);
module.exports = app;
