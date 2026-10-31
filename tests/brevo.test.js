// Welcome email retries against Brevo (no emulators: fetch is replaced).
const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

process.env.BREVO_API_KEY = "test-key";
process.env.CORREO_REMITENTE = "enad@example.org";
const { enviarCorreo } = require("../functions/correo/brevo");

const correo = { para: "ana@example.org", nombre: "Ana", asunto: "Hola", html: "<p>Hola</p>", texto: "Hola" };
let pausas;
const esperar = async (ms) => { pausas.push(ms); };

function respuesta(status, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Headers(headers), text: async () => "{}" };
}

function brevo(...resultados) {
  const llamadas = [];
  const fetch = async (url, opciones) => {
    llamadas.push(opciones);
    const siguiente = resultados.shift();
    if (siguiente instanceof Error) throw siguiente;
    return siguiente;
  };
  return { fetch, llamadas };
}

beforeEach(() => { pausas = []; });

test("a temporary Brevo error is retried once and the email is sent", async () => {
  const { fetch, llamadas } = brevo(respuesta(503), respuesta(201));
  assert.strictEqual(await enviarCorreo(correo, { fetch, esperar }), true);
  assert.strictEqual(llamadas.length, 2);
  assert.deepStrictEqual(pausas, [1000]);
});

test("a rate limit waits what Brevo asks, capped at 3 seconds", async () => {
  const { fetch } = brevo(respuesta(429, { "retry-after": "10" }), respuesta(201));
  assert.strictEqual(await enviarCorreo(correo, { fetch, esperar }), true);
  assert.deepStrictEqual(pausas, [3000]);
});

test("a network failure or timeout is also retried", async () => {
  const { fetch, llamadas } = brevo(new Error("timeout"), respuesta(201));
  assert.strictEqual(await enviarCorreo(correo, { fetch, esperar }), true);
  assert.strictEqual(llamadas.length, 2);
});

test("a bad request or bad key is not retried", async () => {
  const { fetch, llamadas } = brevo(respuesta(401), respuesta(201));
  assert.strictEqual(await enviarCorreo(correo, { fetch, esperar }), false);
  assert.strictEqual(llamadas.length, 1);
  assert.deepStrictEqual(pausas, []);
});

test("after two temporary failures it gives up without throwing", async () => {
  const { fetch, llamadas } = brevo(respuesta(500), respuesta(502));
  assert.strictEqual(await enviarCorreo(correo, { fetch, esperar }), false);
  assert.strictEqual(llamadas.length, 2);
});
