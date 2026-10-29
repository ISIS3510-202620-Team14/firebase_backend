const express = require("express");
const { getFirestore, FieldPath } = require("firebase-admin/firestore");
const { autenticar } = require("../estudiantes/auth");
const { ErrorApi, manejarErrores } = require("../estudiantes/errores");
const { snapshot, version } = require("./records");
const { prepare, school } = require("./mutations");
const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(autenticar);

app.post("/v1/operations", async function synchronize(req, res) {
    const op = req.body;
    if (!op || !/^[\w-]{8,128}$/.test(op.operationId || "") ||
        typeof op.key !== "string" || op.key.length > 300 ||
        !(op.baseVersion === null || /^[a-f0-9]{64}$/.test(op.baseVersion || "")) ||
        typeof op.action !== "string" || !op.body || Array.isArray(op.body) || typeof op.body !== "object") {
        throw new ErrorApi(400, "invalid-argument");
    }
    const db = getFirestore();
    const receipt = db.collection("users").doc(req.usuario.uid).collection("syncReceipts").doc(op.operationId);
    const digest = version(op);
    const result = await db.runTransaction(async function apply(tx) {
        const profile = await tx.get(db.collection("users").doc(req.usuario.uid));
        const user = profile.data();
        if (!user || user.activo === false || !["docente", "admin"].includes(user.rol)) throw new ErrorApi(403, "permission-denied");
        const previous = await tx.get(receipt);
        if (previous.exists) {
            if (previous.get("digest") !== digest) throw new ErrorApi(409, "operation-reused", "Este identificador ya fue utilizado.");
            const scope = previous.get("scope");
            if (scope) await school(tx, user, scope.schoolId, scope.campus);
            return previous.get("result");
        }
        const prepared = await prepare(tx, req.usuario.uid, user, op);
        const result = { operationId: op.operationId, state: prepared.conflict ? "conflict" : "confirmed", records: prepared.records };
        for (const write of prepared.writes || []) tx.set(write.ref, write.data);
        tx.set(receipt, { digest, result, scope: prepared.scope || null, createdAt: new Date().toISOString() });
        return result;
    });
    res.json(result);
});

app.get("/v1/download", async function download(req, res) {
    const db = getFirestore();
    const uid = req.usuario.uid;
    const entity = req.query.entity;
    const parentId = req.query.parentId;
    const limit = 100;
    let query;
    let keyPrefix;
    if (entity === "profile") {
        const profile = await db.collection("users").doc(uid).get();
        return res.json({ records: [snapshot(profile, "profile")], nextCursor: null });
    }
    if (entity === "schools") {
        const ids = req.usuario.schoolIds || [];
        const docs = ids.length ? await db.getAll(...ids.map(function ref(id) { return db.collection("schools").doc(id); })) : [];
        return res.json({ records: docs.map(function item(doc) { return snapshot(doc); }), nextCursor: null });
    }
    if (["students", "groups"].includes(entity)) {
        if (typeof req.query.schoolId !== "string") throw new ErrorApi(400, "invalid-argument");
        if (req.usuario.rol !== "admin" && !req.usuario.schoolIds.includes(req.query.schoolId)) throw new ErrorApi(403, "permission-denied");
        query = db.collection(entity).where("schoolId", "==", req.query.schoolId);
    } else if (["attendance", "evaluations"].includes(entity)) {
        if (typeof parentId !== "string" || !/^[\w-]{1,128}$/.test(parentId)) throw new ErrorApi(400, "invalid-argument");
        const parent = await db.collection("students").doc(parentId).get();
        if (!parent.exists || (req.usuario.rol !== "admin" && !req.usuario.schoolIds.includes(parent.get("schoolId")))) throw new ErrorApi(403, "permission-denied");
        query = parent.ref.collection(entity);
    } else if (entity === "activities") query = db.collection("activityLibrary");
    else if (entity === "hours") query = db.collection("workedHours").where("uid", "==", uid);
    else if (entity === "groupingEvents") query = db.collection("groupingEvents").where("teacherId", "==", uid);
    else if (entity === "plans") query = db.collection("users").doc(uid).collection("actions").where("kind", "==", "flutter_activity");
    else throw new ErrorApi(400, "invalid-argument");
    query = query.orderBy(FieldPath.documentId()).limit(limit);
    if (req.query.cursor !== undefined) {
        if (typeof req.query.cursor !== "string" || req.query.cursor.includes("/") || req.query.cursor.length > 1500) throw new ErrorApi(400, "invalid-argument");
        query = query.startAfter(req.query.cursor);
    }
    const page = await query.get();
    const records = page.docs.map(function item(doc) {
        if (entity === "hours") keyPrefix = "hours/" + doc.get("schoolId") + "/" + doc.get("date");
        else if (entity === "plans") keyPrefix = "plans/" + doc.get("activityId");
        else keyPrefix = doc.ref.path;
        return snapshot(doc, keyPrefix);
    });
    res.json({ records, nextCursor: page.size === limit ? page.docs.at(-1).id : null });
});

app.use(manejarErrores);
module.exports = app;
