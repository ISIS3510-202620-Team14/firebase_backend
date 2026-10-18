const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { autenticar } = require("../estudiantes/auth");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");

const app = express();
app.use(function verificarSesion(req, res, next) {
    autenticar(req, res, next).catch(next);
});

async function listarActividades(req, res) {
    const snapshot = await getFirestore().collection("activityLibrary").get();
    const activities = [];
    for (const document of snapshot.docs) {
        const data = document.data();
        if (data.active === false) {
            continue;
        }
        if (typeof data.title !== "string" || !data.title.trim()
            || !["lectura", "matematicas"].includes(data.subject)
            || !Number.isInteger(data.minutes) || data.minutes <= 0
            || typeof data.description !== "string") {
            throw new ErrorApi(500, "internal", "El catálogo contiene una actividad incompleta.");
        }
        activities.push({
            id: document.id,
            title: data.title,
            subject: data.subject,
            minutes: data.minutes,
            description: data.description,
        });
    }
    activities.sort(function ordenar(first, second) {
        return first.title.localeCompare(second.title, "es");
    });
    res.status(200).json({ activities });
}

app.get("/", function consultarCatalogo(req, res, next) {
    listarActividades(req, res).catch(next);
});

app.use(manejarErrores);
module.exports = app;
