// Correo de bienvenida para un docente recién registrado. Sin dependencias para poder probarlo solo.

// Los nombres los escribe el usuario o un admin: se escapan antes de meterlos al HTML.
function escapar(texto) {
  return String(texto)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// instituciones: [{ nombre, sedes: ["Sede Principal", ...] }]. Devuelve { asunto, html, texto }.
function armarBienvenida({ nombre, instituciones }) {
  const lineas = instituciones.map((i) =>
    i.sedes.length ? `${i.nombre} (${i.sedes.join(", ")})` : i.nombre);

  const asunto = "Bienvenido a ENAd Móvil";

  const texto = [
    `Hola, ${nombre}:`,
    "",
    "Tu cuenta de docente en ENAd Móvil quedó creada.",
    "",
    "Quedaste vinculado a:",
    ...lineas.map((l) => `- ${l}`),
    "",
    "Ya puedes entrar a la app con tu correo y tu contraseña.",
    "",
    "Equipo ENAd Móvil",
  ].join("\n");

  const html = `<!doctype html>
<html lang="es">
  <body style="margin:0;padding:24px;background:#faf6f0;font-family:Arial,sans-serif;color:#221f1f">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7dfd3;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 16px;font-size:22px">Hola, ${escapar(nombre)}</h1>
      <p style="margin:0 0 16px">Tu cuenta de docente en <strong>ENAd Móvil</strong> quedó creada.</p>
      <p style="margin:0 0 8px;color:#6b6259">Quedaste vinculado a:</p>
      <ul style="margin:0 0 20px;padding-left:20px">
        ${lineas.map((l) => `<li>${escapar(l)}</li>`).join("\n        ")}
      </ul>
      <p style="margin:0">Ya puedes entrar a la app con tu correo y tu contraseña.</p>
      <p style="margin:24px 0 0;color:#c62222;font-weight:bold">Equipo ENAd Móvil</p>
    </div>
  </body>
</html>`;

  return { asunto, html, texto };
}

module.exports = { armarBienvenida };
