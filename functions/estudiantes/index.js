const express = require("express");
const { getFirestore } = require("firebase-admin/firestore");
const { ErrorApi, manejarErrores } = require("./errores");
const { autenticar, puedeVerEscuela } = require("./auth");
const { NIVELES, MATERIAS, TIPOS_EVALUACION, GRADOS, SEXOS, MUESTRAS, describirNivel } = require("./niveles");

const TOLERANCIA_FUTURO_MS = 5 * 60 * 1000; // 5 minutos en milisegundos (Margen´para relojes de celular adelantados)
const MAX_IMPORTACION = 200; // Tope de niños por lista importada (una escuela rural tiene pocos cientos)
const ESTADOS_ASISTENCIA = ["vino", "no_vino", "sin_registro"]; // Los mismos tres estados de la app
const ID_CLIENTE = /^[\w-]{8,64}$/; // clientId que genera la app para que un reintento offline no duplique

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

    // Campos que la ficha de la app captura al lado del nombre (todos opcionales).
    if (body.campus !== undefined) {
        if (typeof body.campus === "string" && body.campus.trim()) datos.campus = body.campus.trim();
        else invalidos.push("campus");
    }
    if (body.gender !== undefined) {
        if (SEXOS.includes(body.gender)) datos.gender = body.gender;
        else invalidos.push("gender");
    }
    if (body.age !== undefined) {
        if (Number.isInteger(body.age) && body.age > 0 && body.age < 100) datos.age = body.age;
        else invalidos.push("age");
    }
    if (body.sample !== undefined) {
        if (MUESTRAS.includes(body.sample)) datos.sample = body.sample;
        else invalidos.push("sample");
    }
    if (body.retired !== undefined) {
        if (typeof body.retired === "boolean") datos.retired = body.retired;
        else invalidos.push("retired");
    }
    return { datos, invalidos};
}

// Documento completo de un estudiante recién creado (lo usan crear e importar).
function documentoNuevo(datos, uid, ahora) {
    return {
        gender: null, age: null, sample: 1, campus: null, retired: false, provisional: false,
        ...datos,
        active: true,
        levels: { matematicas: null, lectura: null },
        createdBy: uid,
        createdAt: ahora,
        updatedAt: ahora
    };
}

// Código para el "estudiante inesperado": la app no lo conoce todavía, un mentor lo reemplaza después.
function codigoProvisional() {
    return `PROV-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

// yyyy-mm-dd real (rechaza 2025-02-31).
function esFecha(valor) {
    return typeof valor === "string" && /^\d{4}-\d{2}-\d{2}$/.test(valor)
        && new Date(`${valor}T00:00:00Z`).toISOString().startsWith(valor);
}

function estadoAsistencia(marca) {
    if (!marca.exists) return "sin_registro";
    return marca.get("present") === true ? "vino" : "no_vino";
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
        campus: d.campus ?? null,
        gender: d.gender ?? null,
        age: d.age ?? null,
        sample: d.sample ?? 1,
        retired: d.retired ?? false,
        provisional: d.provisional ?? false,
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
    if(req.query.campus) consulta = consulta.where("campus", "==", req.query.campus);

    // ?date=yyyy-mm-dd agrega la asistencia de ese día (lo que muestra "Mi lista").
    const fecha = req.query.date;
    if(fecha !== undefined && !esFecha(fecha)) throw invalido(["date"]);

    const snap = await consulta.get();
    const q = (req.query.q || "").trim().toLowerCase();
    const students = snap.docs.map(aRespuesta).filter((e) => !q || e.fullName.toLowerCase().includes(q) || e.code.toLowerCase().includes(q)).sort((a,b) => a.fullName.localeCompare(b.fullName, "es"));

    if(fecha && students.length) {
        const marcas = await getFirestore().getAll(
            ...students.map((e) => coleccion().doc(e.id).collection("attendance").doc(fecha))
        );
        students.forEach((e, i) => { e.attendance = estadoAsistencia(marcas[i]); });
    }
    res.status(200).json({students});
});

//crear
app.post("/", async (req, res) => {
    const body = { ...req.body};
    if(req.usuario.rol === "docente") body.schoolId = req.usuario.schoolId;

    // "Estudiante inesperado": la app no manda código y el backend asigna uno provisional.
    const provisional = body.provisional === true;
    if(provisional && body.code === undefined) body.code = codigoProvisional();

    const { datos, invalidos } = validarEstudiante(body);
    if(body.clientId !== undefined && !ID_CLIENTE.test(String(body.clientId))) invalidos.push("clientId");
    if (invalidos.length) throw invalido(invalidos);
    datos.provisional = provisional;

    const ahora = new Date().toISOString();
    const ref = body.clientId ? coleccion().doc(String(body.clientId)) : coleccion().doc();

    // Con clientId, repetir el envío (reintento offline) devuelve el mismo estudiante en vez de duplicarlo.
    const creado = await getFirestore().runTransaction(async (tx) => {
        const previo = await tx.get(ref);
        if(previo.exists) {
            if(!puedeVerEscuela(req.usuario, previo.get("schoolId"))) throw new ErrorApi(409, "already-exists");
            return false;
        }
        if(await codigoOcupado(tx, datos.schoolId, datos.code)) throw new ErrorApi(409, "already-exists");
        tx.set(ref, documentoNuevo(datos, req.usuario.uid, ahora));
        return true;
    });
    res.status(creado ? 201 : 200).json(aRespuesta(await ref.get()));
});

//importar lista (el "Importar lista" de Mi lista): varios niños de una vez, los códigos repetidos se saltan
app.post("/import", async (req, res) => {
    const lista = req.body?.students;
    const schoolId = req.usuario.rol === "docente" ? req.usuario.schoolId : req.body?.schoolId;

    const invalidos = [];
    if(typeof schoolId !== "string" || !schoolId.trim()) invalidos.push("schoolId");
    if(!Array.isArray(lista) || !lista.length || lista.length > MAX_IMPORTACION) invalidos.push("students");
    if(invalidos.length) throw invalido(invalidos);

    const validados = lista.map((item, i) => {
        const { datos, invalidos: malos } = validarEstudiante({ ...item, schoolId: schoolId.trim() });
        malos.forEach((campo) => invalidos.push(`students[${i}].${campo}`));
        return datos;
    });
    if(invalidos.length) throw invalido(invalidos);

    const ahora = new Date().toISOString();
    const resultado = await getFirestore().runTransaction(async (tx) => {
        const existentes = await tx.get(coleccion().where("schoolId", "==", schoolId.trim()).where("active", "==", true));
        const codigos = new Set(existentes.docs.map((d) => d.get("code")));
        const creados = [];
        const omitidos = [];
        for(const datos of validados) {
            if(codigos.has(datos.code)) { omitidos.push(datos.code); continue; }
            codigos.add(datos.code);
            const ref = coleccion().doc();
            tx.set(ref, documentoNuevo(datos, req.usuario.uid, ahora));
            creados.push({ id: ref.id, code: datos.code });
        }
        return { creados, omitidos };
    });
    res.status(201).json({ created: resultado.creados, skipped: resultado.omitidos });
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

    // Cuando un mentor le pone su código real, deja de ser provisional.
    if(datos.code) datos.provisional = false;

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
                retired: false, // Poner un nivel saca al niño de "Retirado", como en la app
                updatedAt: evaluacion.createdAt,
            });
        }
        return true;
    });
    const guardada = (await ref.get()).data();
    res.status(creada ? 201 : 200).json({ id: ref.id,...guardada, ...describirNivel(subject, guardada.level)});
});

//asistencia de un día: vino / no_vino / sin_registro (borra la marca)
app.put("/:id/attendance", async (req, res) => {
    const { date, status } = req.body || {};
    const invalidos = [];
    if(!esFecha(date) || new Date(`${date}T00:00:00Z`).getTime() > Date.now() + 24 * 60 * 60 * 1000) invalidos.push("date");
    if(!ESTADOS_ASISTENCIA.includes(status)) invalidos.push("status");
    if(invalidos.length) throw invalido(invalidos);

    const doc = await cargarEstudiante(req);
    const marca = doc.ref.collection("attendance").doc(date);
    if(status === "sin_registro") await marca.delete();
    else await marca.set({ date, present: status === "vino", recordedBy: req.usuario.uid, updatedAt: new Date().toISOString() });

    res.status(200).json({ id: doc.id, date, status });
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
