const { defineSecret, defineString } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");

// Clave de la API de Brevo. Es secreta: vive en Secret Manager (o en .secret.local con el emulador).
const BREVO_API_KEY = defineSecret("BREVO_API_KEY");
// Remitente verificado en Brevo (Senders, domains & dedicated IPs > Senders).
const CORREO_REMITENTE = defineString("CORREO_REMITENTE", { default: "" });
const NOMBRE_REMITENTE = defineString("NOMBRE_REMITENTE", { default: "ENAd Móvil" });

const URL_BREVO = "https://api.brevo.com/v3/smtp/email";
const TIEMPO_MAXIMO_MS = 10 * 1000;

// Envía un correo transaccional. Nunca lanza: devuelve true si Brevo lo aceptó y false si no,
// para que quien lo llama decida qué hacer sin romper su propio flujo.
async function enviarCorreo({ para, nombre, asunto, html, texto }) {
  const clave = BREVO_API_KEY.value();
  const remitente = CORREO_REMITENTE.value();
  if (!clave || !remitente) {
    logger.warn("correo: falta BREVO_API_KEY o CORREO_REMITENTE, no se envía");
    return false;
  }

  try {
    const respuesta = await fetch(URL_BREVO, {
      method: "POST",
      headers: { "api-key": clave, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        sender: { email: remitente, name: NOMBRE_REMITENTE.value() },
        to: [{ email: para, name: nombre }],
        subject: asunto,
        htmlContent: html,
        textContent: texto,
      }),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });
    if (!respuesta.ok) {
      logger.error(`correo: Brevo respondió ${respuesta.status}: ${await respuesta.text()}`);
      return false;
    }
    return true;
  } catch (e) {
    logger.error(`correo: no se pudo llamar a Brevo: ${e.message}`);
    return false;
  }
}

module.exports = { enviarCorreo, BREVO_API_KEY };
