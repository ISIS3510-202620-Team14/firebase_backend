const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, puedeVerEscuela, escuelaPedida } = require("../estudiantes/auth");

// Firestore acepta máximo 30 valores en un filtro "in"/"array-contains-any", y listar por escuelas los usa.
const MAX_ESCUELAS = 30;

const app = express();
app.use(autenticar);

const usuarios = () => getFirestore().collection("users");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}




// Guardia para las rutas que cambian profesores: solo un admin puede dar o quitar acceso a escuelas.
function soloAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    next();
}





// Lista de escuelas sin espacios ni repetidos. Devuelve null si no es una lista válida.
function limpiarEscuelas(valor) {
    if (!Array.isArray(valor) || !valor.length || valor.length > MAX_ESCUELAS) return null;
    if (!valor.every((s) => typeof s === "string" && s.trim())) return null;
    return [...new Set(valor.map((s) => s.trim()))];
}




// Un profesor es un usuario de "users" con rol "docente". Para promoverlo se identifica por su correo.
function validarProfesor(body = {}) {
    const datos = {};
    const invalidos = [];

    if (typeof body.email === "string" && body.email.includes("@")) datos.email = body.email.trim().toLowerCase();
    else invalidos.push("email");

    const escuelas = limpiarEscuelas(body.schoolIds);
    if (escuelas) datos.schoolIds = escuelas;
    else invalidos.push("schoolIds");

    return { datos, invalidos };
}



// Escuelas de un perfil. Los perfiles viejos traen un solo schoolId.
function escuelasDe(perfil) {
    const antiguo = perfil.get("schoolId");
    return perfil.get("schoolIds") || (antiguo ? [antiguo] : []);
}



// Un docente ve a los profesores con los que comparte al menos una escuela; un admin ve a todos.
function puedeVerProfesor(usuario, perfil) {
    return usuario.rol === "admin" || escuelasDe(perfil).some((s) => usuario.schoolIds.includes(s));
}



function aRespuesta(perfil) {
    return {
        id: perfil.id,
        email: perfil.get("email"),
        fullName: perfil.get("fullName"),
        schoolIds: escuelasDe(perfil),
        createdAt: perfil.get("createdAt"),
        updatedAt: perfil.get("updatedAt") ?? null
    };
}




// Se filtra el rol en el código para que Firestore no pida un índice compuesto con array-contains.
async function listar(consulta, q = "") {
    const snap = await consulta.get();
    const texto = q.trim().toLowerCase();
    return snap.docs
        .filter((p) => p.get("rol") === "docente")
        .map(aRespuesta)
        .filter((p) => !texto || p.fullName?.toLowerCase().includes(texto) || p.email?.toLowerCase().includes(texto))
        .sort((a, b) => (a.fullName || "").localeCompare(b.fullName || "", "es"));
}






//get profesores
app.get("/", async (req, res) => {
    const { usuario } = req;
    const schoolId = escuelaPedida(usuario, req.query.schoolId);

    let consulta = usuarios().where("rol", "==", "docente");
    if (schoolId) consulta = usuarios().where("schoolIds", "array-contains", schoolId);
    else if (usuario.rol === "docente") consulta = usuarios().where("schoolIds", "array-contains-any", usuario.schoolIds);

    res.status(200).json({ teachers: await listar(consulta, req.query.q) });
});





//create profesores: el admin promueve a docente a alguien que ya se registró con /register
app.post("/", soloAdmin, async (req, res) => {
    const { datos, invalidos } = validarProfesor(req.body);
    if (invalidos.length) throw invalido(invalidos);

    let uid;
    try {
        ({ uid } = await getAuth().getUserByEmail(datos.email));
    } catch {
        throw new ErrorApi(404, "not-found", "No hay ninguna cuenta con ese correo. La persona debe registrarse primero.");
    }

    const ref = usuarios().doc(uid);
    const perfil = await ref.get();
    if (!perfil.exists) throw new ErrorApi(404, "not-found", "Esa cuenta todavía no tiene perfil. Pídele que inicie sesión una vez.");
    if (perfil.get("rol") === "admin") throw new ErrorApi(409, "already-exists", "Esa cuenta es de un administrador.");
    if (perfil.get("rol") === "docente") throw new ErrorApi(409, "already-exists", "Esa cuenta ya es de un profesor.");

    await ref.update({ rol: "docente", schoolIds: datos.schoolIds, updatedAt: new Date().toISOString() });
    res.status(201).json(aRespuesta(await ref.get()));
});








//get profesor by id: el profesor y los grupos que tiene a cargo
app.get("/:id", async (req, res) => {
    const perfil = await usuarios().doc(req.params.id).get();
    if (!perfil.exists || perfil.get("rol") !== "docente") throw new ErrorApi(404, "not-found", "No encontramos ese profesor.");
    if (!puedeVerProfesor(req.usuario, perfil)) throw new ErrorApi(403, "permission-denied");

    const grupos = await getFirestore().collection("groups")
        .where("teacherId", "==", perfil.id).where("active", "==", true).get();

    res.status(200).json({
        ...aRespuesta(perfil),
        groups: grupos.docs
            .filter((g) => puedeVerEscuela(req.usuario, g.get("schoolId")))
            .map((g) => ({
                id: g.id,
                name: g.get("name"),
                subject: g.get("subject"),
                schoolId: g.get("schoolId"),
                studentCount: (g.get("studentIds") || []).length
            }))
    });
});






//get profesor by schoolId
app.get("/school/:schoolId", async (req, res) => {
    const schoolId = escuelaPedida(req.usuario, req.params.schoolId);
    const consulta = usuarios().where("schoolIds", "array-contains", schoolId);
    res.status(200).json({ teachers: await listar(consulta, req.query.q) });
});








app.use(manejarErrores);
module.exports = app;
