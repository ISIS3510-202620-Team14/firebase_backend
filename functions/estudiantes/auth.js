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
    const rol = perfil.get("rol");
    const schoolId = perfil.get("schoolId") || null;

    if (!ROLES_CON_ACCESO.includes(rol)) throw new ErrorApi(403, "permission-denied");
    if (rol == "docente" && !schoolId) throw new ErrorApi(403, "no-school");

    req.usuario = { uid, rol, schoolId};
    next();
}

function puedeVerEscuela(usuario, schoolId) {
    return usuario.rol === "admin" || usuario.schoolId === schoolId;
}

module.exports = { autenticar, puedeVerEscuela };