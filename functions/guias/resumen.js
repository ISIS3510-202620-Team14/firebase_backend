// BQ tipo 3: en qué paso de cada guía abandonan los docentes y qué pasos opcionales se saltan.
// Lógica pura (sin Firestore) para poder probarla sola.

const GUIAS = ["hours", "attendance", "evaluation", "activities"];
const PLATAFORMAS = ["kotlin", "flutter"];

const porcentaje = (parte, total) => (total ? Math.round((parte * 1000) / total) / 10 : null);
const pasoValido = (v) => Number.isInteger(v) && v >= 0 && v < 50;

// Pasa un Map paso -> Set de corridas a una lista ordenada de mayor a menor
function porPaso(mapa) {
    return [...mapa]
        .map(([step, corridas]) => ({ step, runs: corridas.size }))
        .sort((a, b) => b.runs - a.runs || a.step - b.step);
}

// eventos: { name, tutorial_id, run_id, step, platform }. Todo se cuenta por run_id distinto,
// así un evento repetido por un reintento no infla nada.
function resumir(eventos) {
    const guias = new Map(GUIAS.map((id) => [id, {
        iniciadas: new Set(),
        completadas: new Set(),
        abandono: new Map(),   // run_id -> paso donde salió
        omitidos: new Map(),   // paso -> Set de run_id
        plataforma: new Map(), // run_id -> plataforma
    }]));

    for (const e of eventos) {
        const g = guias.get(e.tutorial_id);
        if (!g || typeof e.run_id !== "string" || !e.run_id) continue;
        const corrida = e.run_id;
        switch (e.name) {
            case "tutorial_started":
                g.iniciadas.add(corrida);
                if (PLATAFORMAS.includes(e.platform)) g.plataforma.set(corrida, e.platform);
                break;
            case "tutorial_completed":
                g.completadas.add(corrida);
                break;
            case "tutorial_abandoned":
                if (pasoValido(e.step) && !g.abandono.has(corrida)) g.abandono.set(corrida, e.step);
                break;
            case "tutorial_step_skipped":
                if (!pasoValido(e.step)) break;
                if (!g.omitidos.has(e.step)) g.omitidos.set(e.step, new Set());
                g.omitidos.get(e.step).add(corrida);
                break;
        }
    }

    return GUIAS.map((id) => {
        const g = guias.get(id);
        // Solo cuentan las corridas que empezaron dentro del rango
        const completadas = [...g.completadas].filter((c) => g.iniciadas.has(c)).length;
        const abandono = new Map();
        for (const [corrida, paso] of g.abandono) {
            if (!g.iniciadas.has(corrida) || g.completadas.has(corrida)) continue;
            if (!abandono.has(paso)) abandono.set(paso, new Set());
            abandono.get(paso).add(corrida);
        }
        const omitidos = new Map();
        for (const [paso, corridas] of g.omitidos) {
            const validas = new Set([...corridas].filter((c) => g.iniciadas.has(c)));
            if (validas.size) omitidos.set(paso, validas);
        }
        const byPlatform = Object.fromEntries(PLATAFORMAS.map((p) => [p, 0]));
        g.plataforma.forEach((p) => { byPlatform[p]++; });
        const abandonedAtStep = porPaso(abandono);
        return {
            id,
            runs: g.iniciadas.size,
            completed: completadas,
            completionRate: porcentaje(completadas, g.iniciadas.size),
            abandoned: abandonedAtStep.reduce((n, p) => n + p.runs, 0),
            abandonedAtStep,
            skippedSteps: porPaso(omitidos),
            byPlatform,
        };
    });
}

module.exports = { resumir, GUIAS };
