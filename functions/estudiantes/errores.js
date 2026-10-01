const logger = require("firebase-functions/logger")

const MENSAJES = {
    unauthenticated: "Debes iniciar sesión.",
    "permission-denied": "No tienes permiso para esta acción.",
    "no-school": "Tu cuenta todavía no tiene una escuela asignada.",
    "not-found": "No encontramos ese estudiante.",
    "already-exists": "Ya hay un estudiante con ese número en la escuela.",
    "invalid-argument": "Revisa los datos enviados.",
    internal: "No pudimos completar la operación. Intenta de nuevo."
};

class ErrorApi extends Error {
    constructor(estado, code, message = MENSAJES[code]) {
        super(message);
        this.estado = estado;
        this.code = code;
    }
}

function manejarErrores(err, req, res, next) {
    if (err instanceof ErrorApi) {
        return res.status(err.estado).json({ error: { code: err.code, message: err.message}});
    }
    logger.error(`students falló: ${req.method} ${req.path} ${err.message}`);
    return res.status(500).json({ error: { code: "internal", message: MENSAJES.internal}});
}

module.exports = { ErrorApi, manejarErrores };