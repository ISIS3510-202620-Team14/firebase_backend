// Plantilla del correo de bienvenida (no necesita emuladores).
const { test } = require("node:test");
const assert = require("node:assert");
const { armarBienvenida } = require("../functions/correo/bienvenida");

test("la bienvenida saluda por nombre y lista instituciones con sus sedes", () => {
  const { asunto, html, texto } = armarBienvenida({
    nombre: "Ana Ramírez",
    instituciones: [
      { nombre: "I.E.R. La Esperanza", sedes: ["Sede Principal", "Sede Rural"] },
      { nombre: "IE Santo Tomás", sedes: [] },
    ],
  });
  assert.match(asunto, /Bienvenido/);
  assert.match(texto, /Hola, Ana Ramírez/);
  assert.match(texto, /- I\.E\.R\. La Esperanza \(Sede Principal, Sede Rural\)/);
  assert.match(texto, /- IE Santo Tomás\n/);
  assert.match(html, /<li>I\.E\.R\. La Esperanza \(Sede Principal, Sede Rural\)<\/li>/);
});

test("la bienvenida escapa el HTML que venga en los nombres", () => {
  const { html } = armarBienvenida({
    nombre: "<script>alert(1)</script>",
    instituciones: [{ nombre: "IE <b>Falsa</b>", sedes: [] }],
  });
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("IE &lt;b&gt;Falsa&lt;/b&gt;"));
});
