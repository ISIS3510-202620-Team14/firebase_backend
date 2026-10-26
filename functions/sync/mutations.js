const { randomUUID, createHash } = require("node:crypto");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { ErrorApi } = require("../estudiantes/errores");
const { validarEstudiante, documentoNuevo, esFecha } = require("../estudiantes").syncValidation;
const { validarGrupo } = require("../grupos").syncValidation;
const { validarReporte, semanaDe } = require("../horas").syncValidation;
const { NIVELES, MATERIAS, TIPOS_EVALUACION } = require("../estudiantes/niveles");
const { snapshot, record, plain } = require("./records");

function invalid(message = "Revisa los datos enviados.") {
    throw new ErrorApi(400, "invalid-argument", message);
}
function id(value) {
    if (typeof value !== "string" || !/^[\w-]{1,128}$/.test(value)) invalid();
    return value;
}
async function school(tx, user, schoolId, campus) {
    id(schoolId);
    const schools = user.schoolIds || [user.schoolId];
    if (user.rol !== "admin" && !schools.includes(schoolId)) throw new ErrorApi(403, "permission-denied");
    const doc = await tx.get(getFirestore().collection("schools").doc(schoolId));
    if (!doc.exists || doc.get("active") === false) throw new ErrorApi(403, "school-not-found");
    if (campus) {
        const site = (doc.get("campuses") || []).find(function match(item) { return item.id === campus || item.name === campus; });
        if (!site) invalid("La sede no pertenece a la institución.");
        const allowed = user.campusIds?.[schoolId];
        if (user.rol !== "admin" && Array.isArray(allowed) && allowed.length && !allowed.includes(site.id)) {
            throw new ErrorApi(403, "permission-denied");
        }
    }
}
async function prepare(tx, uid, user, op) {
    const db = getFirestore();
    const parts = op.key.split("/");
    const body = op.body || {};
    const root = parts[0];
    let ref;
    if (root === "hours" && parts.length === 3) {
        id(parts[1]);
        if (!esFecha(parts[2])) invalid();
        const old = await tx.get(db.collection("workedHours").doc(uid + "_" + parts[2]));
        const hashed = createHash("sha256").update(JSON.stringify([uid, parts[2], parts[1]])).digest("hex");
        ref = old.exists && old.get("schoolId") === parts[1] ? old.ref : db.collection("workedHours").doc(hashed);
    } else if (["events", "groupingEvents"].includes(root) && parts.length === 2) ref = db.collection(root).doc(id(parts[1]));
    else if (root === "profile" && parts.length === 1) ref = db.collection("users").doc(uid);
    else if (root === "plans" && parts.length === 2) ref = db.collection("users").doc(uid).collection("actions").doc("flutter_activity_" + id(parts[1]));
    else if (["students", "groups"].includes(root) && parts.length === 2) ref = db.collection(root).doc(id(parts[1]));
    else if (root === "students" && parts.length === 4 && parts[2] === "attendance" && esFecha(parts[3])) {
        ref = db.collection("students").doc(id(parts[1])).collection("attendance").doc(parts[3]);
    } else invalid();
    const doc = await tx.get(ref);
    const current = snapshot(doc, op.key);
    let parent;
    if (["events", "groupingEvents"].includes(root) && doc.exists && doc.get("teacherId") !== uid) {
        throw new ErrorApi(403, "permission-denied");
    }
    if (parts[2] === "attendance") {
        parent = await tx.get(ref.parent.parent);
        if (!parent.exists || parent.get("active") === false) throw new ErrorApi(404, "not-found");
        await school(tx, user, parent.get("schoolId"), parent.get("campus"));
    } else if (["students", "groups"].includes(root)) {
        if (!doc.exists && op.action !== "create") throw new ErrorApi(404, "not-found");
        if (doc.exists) await school(tx, user, doc.get("schoolId"), doc.get(root === "groups" ? "campusId" : "campus"));
        if (doc.exists && doc.get("active") === false) throw new ErrorApi(409, "inactive", "Este registro fue eliminado.");
        if (body.schoolId || !doc.exists) await school(tx, user, body.schoolId, body.campusId || body.campus);
    } else if (root === "hours") await school(tx, user, parts[1]);
    const scope = root === "hours" ? { schoolId: parts[1] }
        : parent ? { schoolId: parent.get("schoolId"), campus: parent.get("campus") || null }
        : ["students", "groups"].includes(root) ? {
            schoolId: doc.exists ? doc.get("schoolId") : body.schoolId,
            campus: (doc.exists ? doc.get(root === "groups" ? "campusId" : "campus") : body.campusId || body.campus) || null
        } : null;
    const actualStatus = !doc.exists || doc.get("status") === "sin_registro" ? "sin_registro" : doc.get("present") === true ? "vino" : "no_vino";
    const staleAttendance = parts[2] === "attendance" && body.expectedStatus !== undefined &&
        body.expectedStatus !== actualStatus && body.status !== actualStatus;
    if (current.version !== op.baseVersion || staleAttendance) return { conflict: true, records: [current], scope };
    const now = new Date().toISOString();
    let data = doc.exists ? plain(doc.data()) : {};
    const writes = [];
    const changed = [];
    function set(target, value, key) {
        const next = { ...value, _syncRevision: randomUUID() };
        writes.push({ ref: target, data: next });
        changed.push(record(key || target.path, next));
    }
    if (parts[2] === "attendance") {
        if (op.action !== "attendance" || !["vino", "no_vino", "sin_registro"].includes(body.status) ||
            parts[3] > new Date(Date.now() - 18000000).toISOString().slice(0,10)) invalid();
        data = { date: parts[3], status: body.status, present: body.status === "vino", recordedBy: uid, updatedAt: now };
        set(ref, data, op.key);
    } else if (root === "students") {
        if (op.action === "create" || op.action === "update") {
            const input = { ...body };
            if (op.action === "create" && input.provisional === true && !input.code) input.code = "PROV-" + parts[1].slice(0, 12);
            const checked = validarEstudiante(input, op.action === "update");
            if (checked.invalidos.length || !Object.keys(checked.datos).length) invalid();
            const next = { ...data, ...checked.datos };
            await school(tx, user, next.schoolId, next.campus);
            if (checked.datos.code || op.action === "create" || checked.datos.schoolId) {
                const others = await tx.get(db.collection("students").where("schoolId", "==", next.schoolId).where("code", "==", next.code));
                if (others.docs.some(function other(item) { return item.id !== ref.id && item.get("active") !== false; })) {
                    throw new ErrorApi(409, "already-exists", "Ya existe un estudiante con este código.");
                }
            }
            data = op.action === "create" ? documentoNuevo({ ...checked.datos, provisional: body.provisional === true }, uid, now) : { ...next, updatedAt: now };
            set(ref, data, op.key);
        } else if (op.action === "delete") {
            set(ref, { ...data, active: false, deletedAt: now, deletedBy: uid, updatedAt: now }, op.key);
        } else if (op.action === "evaluate") {
            const date = new Date(body.date);
            if (!MATERIAS.includes(body.subject) || !TIPOS_EVALUACION.includes(body.type) ||
                !NIVELES[body.subject].includes(body.level) || !Number.isFinite(date.getTime()) ||
                date.getTime() > Date.now() + 300000) invalid();
            const evaluation = { subject: body.subject, type: body.type, level: body.level, date: date.toISOString(), evaluatedBy: uid, createdAt: now };
            const level = data.levels?.[body.subject];
            if (!level || level.date <= evaluation.date) {
                data.levels = { ...data.levels, [body.subject]: { level: body.level, date: evaluation.date } };
                data.retired = false;
            }
            set(ref, { ...data, updatedAt: now }, op.key);
            set(ref.collection("evaluations").doc(op.operationId), evaluation);
        } else invalid();
    } else if (root === "groups") {
        if (op.action === "create" || op.action === "update") {
            const checked = validarGrupo({ ...body, teacherId: body.teacherId || data.teacherId || uid }, op.action === "update");
            if (checked.invalidos.length) invalid();
            const next = { ...data, ...checked.datos };
            const teacher = await tx.get(db.collection("users").doc(id(next.teacherId)));
            if (!teacher.exists || teacher.get("activo") === false || teacher.get("rol") !== "docente" ||
                !(teacher.get("schoolIds") || [teacher.get("schoolId")]).includes(next.schoolId)) invalid("Docente no autorizado para esta institución.");
            if ((data.studentIds || []).length && (next.schoolId !== data.schoolId || next.subject !== data.subject)) invalid("Retira los estudiantes antes de cambiar institución o materia.");
            await school(tx, user, next.schoolId, next.campusId);
            set(ref, { campusId: null, schedule: [], studentIds: [], active: true, createdAt: now, ...next, updatedAt: now }, op.key);
        } else if (op.action === "delete") set(ref, { ...data, active: false, updatedAt: now }, op.key);
        else if (["addStudent", "removeStudent"].includes(op.action)) {
            const student = await tx.get(db.collection("students").doc(id(body.studentId)));
            if (!student.exists || student.get("active") === false || student.get("schoolId") !== data.schoolId) invalid("El estudiante no pertenece a esta institución.");
            await school(tx, user, student.get("schoolId"), student.get("campus"));
            const memberships = await tx.get(db.collection("groups").where("studentIds", "array-contains", student.id));
            if (op.action === "addStudent") {
                for (const other of memberships.docs) {
                    if (other.id !== ref.id && other.get("active") !== false && other.get("subject") === data.subject) {
                        throw new ErrorApi(409, "membership-conflict", "El estudiante ya pertenece a otro grupo de esta materia. Retíralo antes de moverlo.");
                    }
                }
            }
            const ids = new Set(data.studentIds || []);
            if (op.action === "addStudent") ids.add(student.id); else ids.delete(student.id);
            set(ref, { ...data, studentIds: [...ids], updatedAt: now }, op.key);
        } else invalid();
    } else if (root === "hours") {
        if (op.action !== "save") invalid();
        const checked = validarReporte(parts[2], body);
        set(ref, { uid, rol: user.rol, schoolId: parts[1], date: parts[2], week: semanaDe(parts[2]),
            plannedHours: body.plannedHours, workedHours: body.workedHours, origin: body.origin,
            reason: checked.motivo, presentAtCampus: body.presentAtCampus, platform: "flutter",
            appVersion: body.appVersion.trim(), savedAt: Timestamp.fromMillis(checked.guardado), receivedAt: now }, op.key);
    } else if (root === "events") {
        if (op.action !== "create" || typeof body.name !== "string" || !/^[a-zA-Z0-9_]{1,80}$/.test(body.name)) invalid();
        set(ref, { ...body, teacherId: uid, platform: "flutter", createdAt: Timestamp.now() }, op.key);
    } else if (root === "groupingEvents") {
        if (op.action !== "create" || !MATERIAS.includes(body.subject) || !Number.isInteger(body.classSize) ||
            body.classSize < 0 || !["manual", "automatic"].includes(body.method)) invalid();
        set(ref, { subject: body.subject, classSize: body.classSize, method: body.method, timestamp: now,
            teacherId: uid, createdBy: uid, createdAt: now }, op.key);
    } else if (root === "profile") {
        if (op.action !== "update" || typeof body.fullName !== "string" || !body.fullName.trim() || body.fullName.length > 150) invalid();
        set(ref, { ...data, fullName: body.fullName.trim() }, op.key);
    } else if (root === "plans") {
        if (op.action !== "create" || !esFecha(body.date)) invalid();
        const template = await tx.get(db.collection("activityLibrary").doc(id(body.templateId)));
        if (!template.exists || template.get("active") === false) invalid("La actividad ya no está disponible.");
        set(ref, { activityId: parts[1], templateId: template.id, title: template.get("title"), subject: template.get("subject"),
            minutes: template.get("minutes"), source: "library", kind: "flutter_activity",
            date: body.date, platform: "flutter", createdAt: now }, op.key);
        set(db.collection("events").doc("flutter_activity_" + parts[1]), { teacherId: uid, name: "activity_selected",
            activityId: parts[1], templateId: template.id, platform: "flutter", createdAt: Timestamp.now() });
    }
    return { records: changed, writes, scope };
}
module.exports = { prepare, school };
