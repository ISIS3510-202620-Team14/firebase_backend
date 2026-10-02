const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi } = require("./errores");

const ROLES_CON_ACCESO = ["docente", "admin"];

async function autenticar(req, res, next) {
    const [tipo, token]  = (req.get("Authorization") || "").split(" ");
    if (tipo != "Bearer" || !token) throw new ErrorApi(401, "unauthenticated");

    let uid;
    try {
        ({uid } = await getAuth().verifyIdToken(token));
    } catch {
        throw new ErrorApi(401, "unauthenticated");
    }

    const perfil = await getFirestore().collection("users").doc(uid).get();
    // Una cuenta desactivada pierde el acceso aunque su token siga vigente.
    if (perfil.get("activo") === false) throw new ErrorApi(403, "user-disabled");
    const rol = perfil.get("rol");
    // Un docente puede trabajar en varias escuelas. Los perfiles viejos traen un solo schoolId.
    const antiguo = perfil.get("schoolId");
    const schoolIds = perfil.get("schoolIds") || (antiguo ? [antiguo] : []);

    if (!ROLES_CON_ACCESO.includes(rol)) throw new ErrorApi(403, "permission-denied");
    if (rol == "docente" && !schoolIds.length) throw new ErrorApi(403, "no-school");

    req.usuario = { uid, rol, schoolIds };
    next();
}

function puedeVerEscuela(usuario, schoolId) {
    return usuario.rol === "admin" || usuario.schoolIds.includes(schoolId);
}

// Escuela con la que trabaja una petición: la que manda el cliente o, si el docente tiene una sola, esa.
// Devuelve undefined si no se sabe cuál es; lanza 403 si es una escuela ajena.
function escuelaPedida(usuario, schoolId) {
    if (schoolId === undefined && usuario.rol === "docente" && usuario.schoolIds.length === 1) {
        return usuario.schoolIds[0];
    }
    if (typeof schoolId === "string" && !puedeVerEscuela(usuario, schoolId)) {
        throw new ErrorApi(403, "permission-denied");
    }
    return schoolId;
}

module.exports = { autenticar, puedeVerEscuela, escuelaPedida };