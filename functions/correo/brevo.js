const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Clave de la API de Brevo. Es secreta: vive en Secret Manager (o en .secret.local con el emulador).
const BREVO_API_KEY = defineSecret("BREVO_API_KEY");
// Remitente verificado en Brevo (Senders, domains & dedicated IPs > Senders).
const CORREO_REMITENTE = defineString("CORREO_REMITENTE", { default: "" });
const NOMBRE_REMITENTE = defineString("NOMBRE_REMITENTE", { default: "ENAd Móvil" });

const URL_BREVO = "https://api.brevo.com/v3/smtp/email";
const TIEMPO_MAXIMO_MS = 10 * 1000;
// A temporary failure (rate limit, Brevo down, timeout) is tried once more after a short pause.
const INTENTOS = 2;
const PAUSA_MS = 1000;
const PAUSA_MAXIMA_MS = 3000;

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 429 and 5xx can work a moment later; a 4xx like a bad key or a bad address will not.
const esTemporal = (estado) => estado === 429 || estado >= 500;

// Pause before the retry: Brevo's Retry-After when it sends one, capped so registration stays fast.
function pausaDe(respuesta) {
  const segundos = Number(respuesta?.headers?.get?.("retry-after"));
  if (Number.isFinite(segundos) && segundos > 0) return Math.min(segundos * 1000, PAUSA_MAXIMA_MS);
  return PAUSA_MS;
}

// Envía un correo transaccional. Nunca lanza: devuelve true si Brevo lo aceptó y false si no,
// para que quien lo llama decida qué hacer sin romper su propio flujo.
// [opciones] lets the tests replace fetch and the pause.
async function enviarCorreo({ para, nombre, asunto, html, texto }, opciones = {}) {
  const pedir = opciones.fetch ?? fetch;
  const pausar = opciones.esperar ?? esperar;
  // Al pegar la clave en la terminal es fácil que se cuele un espacio o un salto de línea.
  const clave = BREVO_API_KEY.value().trim();
  const remitente = CORREO_REMITENTE.value().trim();
  if (!clave || !remitente) {
    logger.warn("correo: falta BREVO_API_KEY o CORREO_REMITENTE, no se envía");
    return false;
  }
  const cuerpo = JSON.stringify({
    sender: { email: remitente, name: NOMBRE_REMITENTE.value() },
    to: [{ email: para, name: nombre }],
    subject: asunto,
    htmlContent: html,
    textContent: texto,
  });

  for (let intento = 1; intento <= INTENTOS; intento++) {
    let respuesta;
    try {
      respuesta = await pedir(URL_BREVO, {
        method: "POST",
        headers: { "api-key": clave, "Content-Type": "application/json", Accept: "application/json" },
        body: cuerpo,
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      });
    } catch (e) {
      // No answer at all (network or timeout) is also temporary.
      logger.error(`correo: no se pudo llamar a Brevo (intento ${intento}): ${e.message}`);
      if (intento < INTENTOS) await pausar(PAUSA_MS);
      continue;
    }
    if (respuesta.ok) {
      if (intento > 1) logger.info(`correo: Brevo aceptó el correo en el intento ${intento}`);
      return true;
    }
    logger.error(`correo: Brevo respondió ${respuesta.status} (intento ${intento}): ${await respuesta.text()}`);
    if (!esTemporal(respuesta.status)) return false;
    if (intento < INTENTOS) await pausar(pausaDe(respuesta));
  }
  return false;
}

module.exports = { enviarCorreo, BREVO_API_KEY };
