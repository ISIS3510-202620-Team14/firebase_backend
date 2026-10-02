const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { autenticar, puedeVerEscuela } = require("../estudiantes/auth");

const ETAPAS = 7; // El ciclo ENAd tiene 7 etapas
const ZONAS = ["rural", "urbana"];
const MAX_SEDES = 20;

const app = express();
app.use(autenticar);

const db = () => getFirestore();
const coleccion = () => db().collection("schools");

function invalido(campos) {
    return new ErrorApi(400, "invalid-argument", `Revisa estos campos: ${campos.join(", ")}.`);
}

// Solo un admin crea, edita o da de baja instituciones y sedes. El docente las consulta.
function soloAdmin(req, res, next) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    next();
}

// "IE Sagrada Familia" -> "ie-sagrada-familia". Sirve para el id y para comparar nombres sin tildes ni mayúsculas.
function slug(texto) {
    return String(texto ?? "")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// Para buscar: "Apía" y "apia" son lo mismo.
function sinTildes(texto) {
    return String(texto ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Texto de 2 a max caracteres que deje un slug no vacío. Devuelve null si no sirve.
function textoValido(valor, max) {
    const limpio = typeof valor === "string" ? valor.trim() : "";
    return limpio.length >= 2 && limpio.length <= max && slug(limpio) ? limpio : null;
}

// ["Antonia Santos", ...] -> [{ id, name }]. Devuelve null si hay una sede inválida o repetida.
function sedesDesde(lista) {
    if (!Array.isArray(lista) || lista.length > MAX_SEDES) return null;
    const sedes = [];
    for (const nombre of lista) {
        const name = textoValido(nombre, 80);
        if (!name || sedes.some((s) => s.id === slug(name))) return null;
        sedes.push({ id: slug(name), name });
    }
    return sedes;
}

// Revisa el cuerpo de crear (nombre, departamento y municipio obligatorios) o editar (solo lo que llegue).
function validarEscuela(body = {}, parcial = false) {
    const datos = {};
    const invalidos = [];

    for (const [campo, max] of [["name", 120], ["department", 80], ["municipality", 80]]) {
        if (parcial && body[campo] === undefined) continue;
        const valor = textoValido(body[campo], max);
        if (valor) datos[campo] = valor;
        else invalidos.push(campo);
    }
    if (body.zone !== undefined) {
        if (ZONAS.includes(body.zone)) datos.zone = body.zone;
        else invalidos.push("zone");
    }
    if (body.enadStage !== undefined) {
        if (Number.isInteger(body.enadStage) && body.enadStage >= 1 && body.enadStage <= ETAPAS) datos.enadStage = body.enadStage;
        else invalidos.push("enadStage");
    }
    if (!parcial && body.campuses !== undefined) {
        const sedes = sedesDesde(body.campuses);
        if (sedes) datos.campuses = sedes;
        else invalidos.push("campuses");
    }
    return { datos, invalidos };
}

// Las instituciones creadas a mano en la consola pueden no traer "active" ni los demás campos.
function aRespuesta(doc) {
    const d = doc.data();
    return {
        id: doc.id,
        name: d.name ?? doc.id,
        department: d.department ?? null,
        municipality: d.municipality ?? null,
        zone: d.zone ?? null,
        enadStage: d.enadStage ?? null,
        campuses: d.campuses ?? [],
        createdAt: d.createdAt ?? null,
        updatedAt: d.updatedAt ?? null
    };
}

async function cargarEscuela(req) {
    const doc = await coleccion().doc(req.params.id).get();
    if (!doc.exists || doc.get("active") === false) throw new ErrorApi(404, "not-found", "No encontramos esa institución.");
    if (!puedeVerEscuela(req.usuario, doc.id)) throw new ErrorApi(403, "permission-denied");
    return doc;
}

// Docentes de una institución. Se filtra el rol en el código para no pedir un índice compuesto con array-contains.
async function docentesDe(schoolId) {
    const [nuevos, antiguos] = await Promise.all([
        db().collection("users").where("schoolIds", "array-contains", schoolId).get(),
        db().collection("users").where("schoolId", "==", schoolId).get()
    ]);
    const porId = new Map([...nuevos.docs, ...antiguos.docs].map((p) => [p.id, p]));
    return [...porId.values()].filter((p) => p.get("rol") === "docente");
}

const contar = async (consulta) => (await consulta.count().get()).data().count;

// Otra institución activa con el mismo nombre en el mismo municipio.
async function nombreOcupado(name, municipality, excluirId) {
    const clave = `${slug(name)}|${slug(municipality)}`;
    const todas = await coleccion().get();
    return todas.docs.some((d) => d.id !== excluirId && d.get("active") !== false
        && `${slug(d.get("name"))}|${slug(d.get("municipality"))}` === clave);
}

//listar: el admin ve todas (con filtros); el docente solo las suyas
app.get("/", async (req, res) => {
    const { usuario } = req;
    let docs;

    if (usuario.rol === "admin") {
        let consulta = coleccion();
        for (const campo of ["department", "municipality", "zone"]) {
            if (req.query[campo]) consulta = consulta.where(campo, "==", String(req.query[campo]));
        }
        docs = (await consulta.get()).docs;
    } else {
        docs = await db().getAll(...usuario.schoolIds.map((id) => coleccion().doc(id)));
    }

    const q = sinTildes(String(req.query.q || "").trim());
    const schools = docs
        .filter((d) => d.exists && d.get("active") !== false)
        .map(aRespuesta)
        .filter((e) => !q || sinTildes(e.name).includes(q) || sinTildes(e.municipality).includes(q))
        .sort((a, b) => a.name.localeCompare(b.name, "es"));

    res.status(200).json({ schools });
});

//crear: el id sale de nombre + municipio, así que dos iguales chocan solas
app.post("/", soloAdmin, async (req, res) => {
    const { datos, invalidos } = validarEscuela(req.body);
    if (invalidos.length) throw invalido(invalidos);

    const ahora = new Date().toISOString();
    const ref = coleccion().doc(`${slug(datos.name)}-${slug(datos.municipality)}`);

    await db().runTransaction(async (tx) => {
        const previa = await tx.get(ref);
        if (previa.exists) {
            throw new ErrorApi(409, "already-exists", previa.get("active") === false
                ? "Esa institución existe pero está dada de baja."
                : "Ya existe una institución con ese nombre en ese municipio.");
        }
        tx.set(ref, {
            zone: null, enadStage: 1, campuses: [],
            ...datos,
            active: true,
            createdBy: req.usuario.uid,
            createdAt: ahora,
            updatedAt: ahora
        });
    });
    res.status(201).json(aRespuesta(await ref.get()));
});

//detalle: datos, sedes y cuántos estudiantes, grupos y docentes tiene
app.get("/:id", async (req, res) => {
    const doc = await cargarEscuela(req);
    const [students, groups, docentes] = await Promise.all([
        contar(db().collection("students").where("schoolId", "==", doc.id).where("active", "==", true)),
        contar(db().collection("groups").where("schoolId", "==", doc.id).where("active", "==", true)),
        docentesDe(doc.id)
    ]);
    res.status(200).json({ ...aRespuesta(doc), totals: { students, groups, teachers: docentes.length } });
});

//editar: las sedes se cambian en /:id/campuses para no dejar estudiantes en una sede que ya no existe
app.patch("/:id", soloAdmin, async (req, res) => {
    const doc = await cargarEscuela(req);
    if (req.body?.campuses !== undefined) {
        throw new ErrorApi(400, "invalid-argument", "Las sedes se agregan o quitan en /:id/campuses.");
    }
    const { datos, invalidos } = validarEscuela(req.body, true);
    if (invalidos.length) throw invalido(invalidos);
    if (!Object.keys(datos).length) throw new ErrorApi(400, "invalid-argument", "No enviaste ningún campo para actualizar.");

    if (datos.name || datos.municipality) {
        const name = datos.name ?? doc.get("name");
        const municipality = datos.municipality ?? doc.get("municipality");
        if (await nombreOcupado(name, municipality, doc.id)) {
            throw new ErrorApi(409, "already-exists", "Ya existe una institución con ese nombre en ese municipio.");
        }
    }
    await doc.ref.update({ ...datos, updatedAt: new Date().toISOString() });
    res.status(200).json(aRespuesta(await doc.ref.get()));
});

//eliminar: baja lógica, y solo si nadie sigue vinculado a la institución
app.delete("/:id", soloAdmin, async (req, res) => {
    const doc = await cargarEscuela(req);
    const [students, groups, docentes] = await Promise.all([
        contar(db().collection("students").where("schoolId", "==", doc.id).where("active", "==", true)),
        contar(db().collection("groups").where("schoolId", "==", doc.id).where("active", "==", true)),
        docentesDe(doc.id)
    ]);

    const pendientes = [];
    if (students) pendientes.push(`${students} estudiante(s)`);
    if (groups) pendientes.push(`${groups} grupo(s)`);
    if (docentes.length) pendientes.push(`${docentes.length} docente(s)`);
    if (pendientes.length) {
        throw new ErrorApi(409, "has-dependents", `No se puede dar de baja: todavía tiene ${pendientes.join(", ")}.`);
    }

    const ahora = new Date().toISOString();
    await doc.ref.update({ active: false, deletedBy: req.usuario.uid, deletedAt: ahora, updatedAt: ahora });
    res.status(200).json({ id: doc.id, active: false });
});

//agregar sede
app.post("/:id/campuses", soloAdmin, async (req, res) => {
    const doc = await cargarEscuela(req);
    const name = textoValido(req.body?.name, 80);
    if (!name) throw invalido(["name"]);

    await db().runTransaction(async (tx) => {
        const actual = await tx.get(doc.ref);
        const sedes = actual.get("campuses") || [];
        if (sedes.some((s) => s.id === slug(name))) throw new ErrorApi(409, "already-exists", "Esa sede ya existe en la institución.");
        if (sedes.length >= MAX_SEDES) throw new ErrorApi(400, "invalid-argument", `Una institución no puede tener más de ${MAX_SEDES} sedes.`);
        tx.update(doc.ref, { campuses: [...sedes, { id: slug(name), name }], updatedAt: new Date().toISOString() });
    });
    res.status(201).json(aRespuesta(await doc.ref.get()));
});

//quitar sede: los estudiantes guardan el nombre de su sede, así que no se quita si todavía hay alguno ahí
app.delete("/:id/campuses/:campusId", soloAdmin, async (req, res) => {
    const doc = await cargarEscuela(req);
    const sede = (doc.get("campuses") || []).find((s) => s.id === req.params.campusId);
    if (!sede) throw new ErrorApi(404, "not-found", "No encontramos esa sede.");

    const estudiantes = await contar(
        db().collection("students").where("schoolId", "==", doc.id).where("active", "==", true).where("campus", "==", sede.name)
    );
    if (estudiantes) {
        throw new ErrorApi(409, "has-dependents", `No se puede quitar la sede: todavía tiene ${estudiantes} estudiante(s).`);
    }

    await db().runTransaction(async (tx) => {
        const actual = await tx.get(doc.ref);
        const sedes = (actual.get("campuses") || []).filter((s) => s.id !== sede.id);
        tx.update(doc.ref, { campuses: sedes, updatedAt: new Date().toISOString() });
    });
    res.status(200).json(aRespuesta(await doc.ref.get()));
});

app.use(manejarErrores);
module.exports = app;
