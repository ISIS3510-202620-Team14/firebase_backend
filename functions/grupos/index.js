const express = require("express");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar } = require("../estudiantes/auth");
const { MATERIAS } = require("../estudiantes/niveles");

const app = express();
app.use(autenticar);

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

app.use(manejarErrores);
module.exports = app;
