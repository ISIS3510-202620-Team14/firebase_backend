const { FieldPath } = require("firebase-admin/firestore");
const { ErrorApi } = require("../estudiantes/errores");
const { NIVELES } = require("../estudiantes/niveles");

const HEADERS = ["category", "metric", "week", "platform", "version", "dimension", "value", "status", "exportedAt"];
const TUTORIALS = new Set(["hours", "attendance", "evaluation", "activities"]);
const EVENTS = ["tutorial_started", "tutorial_completed", "tutorial_abandoned", "attendance_sync", "scanner_page_processed"];

/** Reads complete pages or fails before returning partial metrics. */
async function readAll(query, limit = 10000) {
    const values = [];
    let last;
    while (true) {
        let page = query.orderBy(FieldPath.documentId()).limit(500);
        if (last) page = page.startAfter(last);
        const snapshot = await page.get();
        for (const doc of snapshot.docs) values.push(doc.data());
        if (values.length > limit) throw new ErrorApi(413, "export-too-large", "La exportación supera el límite. Requiere un rango de fechas.");
        if (snapshot.size < 500) return values;
        last = snapshot.docs.at(-1);
    }
}

/** Keeps only supported platform labels. */
function platform(value) {
    return ["flutter", "kotlin"].includes(value) ? value : "unknown";
}

/** Keeps numeric app versions, never free text. */
function version(value) {
    return typeof value === "string" && /^\d{1,4}(\.\d{1,4}){0,3}(\+\d{1,8})?$/.test(value) ? value : "unknown";
}

/** Returns the Colombian week for a timestamp. */
function week(value) {
    if (!value) return "unknown";
    const date = value.toDate ? value.toDate() : new Date(value);
    if (!Number.isFinite(date.getTime())) return "unknown";
    date.setTime(date.getTime() - 5 * 60 * 60 * 1000);
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
}

/** Accepts a real Monday supplied by a client. */
function clientWeek(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "unknown";
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.getUTCDay() === 1 && date.toISOString().startsWith(value) ? value : "unknown";
}

/** Uses finite, nonnegative counters only. */
function count(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Computes a nearest-rank percentile from sorted samples. */
function percentile(values, fraction) {
    return values[Math.max(0, Math.ceil(values.length * fraction) - 1)];
}

/** Builds sanitized long-form rows for Sheets and Looker. */
function aggregate(events, opens, students, exportedAt) {
    const rows = [];
    const counters = new Map();
    const durations = new Map();
    const opensByTeacher = new Map();
    const available = new Set();

    /** Adds an aggregate without including account or student identifiers. */
    function add(category, metric, date, app, release, dimension, amount) {
        available.add(category);
        const key = JSON.stringify([category, metric, date, app, release, dimension]);
        counters.set(key, (counters.get(key) || 0) + amount);
    }

    for (const event of events) {
        const app = platform(event.platform);
        const release = version(event.appVersion);
        const date = week(event.createdAt);
        if (event.name.startsWith("tutorial_") && TUTORIALS.has(event.tutorial_id)) {
            add("tutorials", event.name, date, app, release, event.tutorial_id, 1);
        } else if (event.name === "attendance_sync") {
            const network = ["online", "offline"].includes(event.connectivity) ? event.connectivity : "unknown";
            const sent = count(event.sent);
            const conflicts = count(event.conflicts);
            add("attendance", "sent", clientWeek(event.week), app, release, network, sent);
            add("attendance", "replaced", clientWeek(event.week), app, release, network, conflicts);
            add("attendance", "total", clientWeek(event.week), app, release, network, sent + conflicts);
        } else if (event.name === "scanner_page_processed") {
            const status = ["ready", "empty", "error"].includes(event.status) ? event.status : "unknown";
            add("scanner", "pages", date, app, release, status, 1);
            add("scanner", "rows", date, app, release, status, count(event.rows));
            for (const metric of ["ocrMs", "parseMs", "totalMs"]) {
                if (typeof event[metric] !== "number" || !Number.isFinite(event[metric]) || event[metric] < 0) continue;
                const key = JSON.stringify(["scanner", metric, date, app, release, status]);
                if (!durations.has(key)) durations.set(key, []);
                durations.get(key).push(event[metric]);
            }
        }
    }
    for (const open of opens) {
        if (open.rol !== "docente") continue;
        add("app_opens", "opens", clientWeek(open.week), platform(open.platform), version(open.appVersion), "all", 1);
        if (typeof open.uid === "string") {
            const key = JSON.stringify([clientWeek(open.week), platform(open.platform), version(open.appVersion)]);
            if (!opensByTeacher.has(key)) opensByTeacher.set(key, new Map());
            const teachers = opensByTeacher.get(key);
            teachers.set(open.uid, (teachers.get(open.uid) || 0) + 1);
        }
    }
    for (const [key, teachers] of opensByTeacher) {
        const dimensions = JSON.parse(key);
        let reachedGoal = 0;
        for (const amount of teachers.values()) if (amount >= 2) reachedGoal++;
        add("app_opens", "teachers", ...dimensions, "all", teachers.size);
        add("app_opens", "teachers_with_two_opens", ...dimensions, "all", reachedGoal);
    }
    for (const student of students) {
        if (student.active === false || student.retired === true) continue;
        for (const subject of Object.keys(NIVELES)) {
            const level = student.levels?.[subject]?.level;
            const dimension = NIVELES[subject].includes(level) ? level : "unclassified";
            add("subject_progress", "students", "snapshot", "all", "all", `${subject}:${dimension}`, 1);
        }
    }
    for (const [key, value] of counters) rows.push([...JSON.parse(key), value, "available", exportedAt]);
    for (const [key, values] of durations) {
        // # micro opt
        values.sort(function ascending(a, b) { return a - b; });
        const dimensions = JSON.parse(key);
        const middle = Math.floor(values.length / 2);
        const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
        for (const [suffix, value] of [["median", median], ["p95", percentile(values, 0.95)]]) {
            rows.push([dimensions[0], `${dimensions[1]}_${suffix}`, ...dimensions.slice(2), value, "available", exportedAt]);
        }
    }
    for (const category of ["tutorials", "app_opens", "subject_progress", "attendance", "scanner"]) {
        if (!available.has(category)) rows.push([category, "source", "", "", "", "", "", "unavailable", exportedAt]);
    }
    return { exportedAt, headers: HEADERS, rows };
}

/** Exports available aggregates for authenticated administrators. */
async function exportAnalytics(req, res, db) {
    if (req.usuario.rol !== "admin") throw new ErrorApi(403, "permission-denied");
    const [events, opens, students] = await Promise.all([
        readAll(db.collection("events").where("name", "in", EVENTS)),
        readAll(db.collection("app_opens")),
        readAll(db.collection("students")),
    ]);
    res.json(aggregate(events, opens, students, new Date().toISOString()));
}

module.exports = { exportAnalytics, aggregate, readAll };
