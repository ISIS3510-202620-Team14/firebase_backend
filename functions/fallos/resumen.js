// BQ tipo 1: qué porcentaje de las sesiones de la app terminan en un fallo y en qué pantalla,
// versión, modelo y Android se concentran. Lógica pura (sin Firestore) para poder probarla sola.

const DIA_MS = 24 * 60 * 60 * 1000;
const COLOMBIA_MS = 5 * 60 * 60 * 1000;

const porcentaje = (parte, total) => (total ? Math.round((parte * 1000) / total) / 10 : null);
const texto = (v) => (typeof v === "string" && v.trim() ? v.trim() : "unknown");

// Lunes (yyyy-MM-dd, hora de Colombia) de la semana de un instante en ms
function lunesDe(ms) {
    const d = new Date(ms - COLOMBIA_MS);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
}

// Agrupa por una clave: sesiones y sesiones con fallo de cada grupo
function agrupar(sesiones, fallidas, clave) {
    const filas = new Map();
    for (const s of sesiones.values()) {
        const k = texto(clave(s));
        const fila = filas.get(k) || { key: k, sessions: 0, crashes: 0 };
        fila.sessions++;
        if (fallidas.has(s.sessionId)) fila.crashes++;
        filas.set(k, fila);
    }
    return [...filas.values()]
        .map((f) => ({ ...f, crashRate: porcentaje(f.crashes, f.sessions) }))
        .sort((a, b) => b.crashes - a.crashes || b.sessions - a.sessions);
}

// eventos: { name: app_session | app_crash, sessionId, appVersion, model, androidVersion,
// screen, error, createdAtMs }. Todo se cuenta por sessionId distinto.
function resumir(eventos, semanas, ahoraMs) {
    const sesiones = new Map();
    const fallos = new Map();
    for (const e of eventos) {
        if (typeof e.sessionId !== "string" || !e.sessionId) continue;
        if (e.name === "app_session" && !sesiones.has(e.sessionId)) sesiones.set(e.sessionId, e);
        if (e.name === "app_crash" && !fallos.has(e.sessionId)) fallos.set(e.sessionId, e);
    }
    // Un fallo sin su sesión (llegó tarde o se perdió) igual cuenta como sesión
    for (const [id, f] of fallos) if (!sesiones.has(id)) sesiones.set(id, f);

    const lunesActual = lunesDe(ahoraMs);
    const listaSemanas = [];
    for (let i = semanas - 1; i >= 0; i--) listaSemanas.push(lunesDe(ahoraMs - i * 7 * DIA_MS));
    const porSemana = new Map(listaSemanas.map((w) => [w, { week: w, sessions: 0, crashes: 0 }]));
    for (const s of sesiones.values()) {
        const fila = porSemana.get(lunesDe(s.createdAtMs));
        if (!fila) continue;
        fila.sessions++;
        if (fallos.has(s.sessionId)) fila.crashes++;
    }

    const pantallas = new Map();
    for (const f of fallos.values()) {
        const k = texto(f.screen);
        pantallas.set(k, (pantallas.get(k) || 0) + 1);
    }

    const total = sesiones.size;
    const conFallo = fallos.size;
    return {
        weeks: semanas,
        sessions: total,
        crashes: conFallo,
        crashRate: porcentaje(conFallo, total),
        crashFreeRate: total ? Math.round((1000 - (conFallo * 1000) / total)) / 10 : null,
        byWeek: [...porSemana.values()].map((w) => ({ ...w, crashRate: porcentaje(w.crashes, w.sessions) })),
        byScreen: [...pantallas]
            .map(([screen, crashes]) => ({ screen, crashes, share: porcentaje(crashes, conFallo) }))
            .sort((a, b) => b.crashes - a.crashes),
        byVersion: agrupar(sesiones, fallos, (s) => s.appVersion).map(({ key, ...f }) => ({ appVersion: key, ...f })),
        byModel: agrupar(sesiones, fallos, (s) => s.model).map(({ key, ...f }) => ({ model: key, ...f })),
        byAndroid: agrupar(sesiones, fallos, (s) => s.androidVersion).map(({ key, ...f }) => ({ androidVersion: key, ...f })),
        provisional: listaSemanas[listaSemanas.length - 1] === lunesActual,
    };
}

module.exports = { resumir, lunesDe };
