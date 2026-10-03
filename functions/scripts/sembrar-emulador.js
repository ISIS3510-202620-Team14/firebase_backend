// Llena los emuladores locales con datos de prueba para usar la app contra ellos:
// 2 instituciones con estudiantes de grados 3 a 5, un docente de ambas y un admin.
// Uso (con los emuladores encendidos): npm run sembrar   (desde functions/)
// Se puede correr varias veces: sobrescribe los mismos documentos.

// Siempre contra los emuladores: este script nunca debe tocar producción.
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";

const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp({ projectId: "enad-movil" });
const db = getFirestore();
const auth = getAuth();

// Cuentas de prueba (solo existen en el emulador).
const CUENTAS = [
  { uid: "docente-demo", email: "docente@enad.test", password: "docente123", fullName: "Docente Demo", rol: "docente" },
  { uid: "admin-demo", email: "admin@enad.test", password: "admin123", fullName: "Admin Demo", rol: "admin" },
];

const ESCUELAS = [
  { id: "ie-el-carmen", name: "IE El Carmen", municipality: "Apía", estudiantes: 30 },
  { id: "ie-san-jose", name: "IE San José", municipality: "Belén de Umbría", estudiantes: 12 },
];

const NOMBRES = ["Ana", "Beto", "Carla", "Dani", "Elena", "Felipe", "Gabi", "Hugo", "Isa", "Juan",
  "Karen", "Luis", "Mara", "Nico", "Olga", "Pablo", "Quique", "Rosa", "Sergio", "Tania"];
const APELLIDOS = ["Ríos", "Gómez", "Pérez", "Mejía", "Restrepo", "Cruz", "Salazar", "Pardo"];

async function main() {
  for (const e of ESCUELAS) {
    await db.collection("schools").doc(e.id).set({
      name: e.name, department: "Risaralda", municipality: e.municipality, zone: "rural",
      active: true, campuses: [{ id: `${e.id}-principal`, name: "Sede principal" }],
    });
    const lote = db.batch();
    for (let i = 0; i < e.estudiantes; i++) {
      const ahora = new Date().toISOString();
      lote.set(db.collection("students").doc(`${e.id}-est-${i + 1}`), {
        schoolId: e.id,
        code: `${e.id.slice(3, 6).toUpperCase()}-${String(i + 1).padStart(3, "0")}`,
        fullName: `${NOMBRES[i % NOMBRES.length]} ${APELLIDOS[i % APELLIDOS.length]} ${APELLIDOS[(i + 3) % APELLIDOS.length]}`,
        grade: 3 + (i % 3),
        gender: i % 2 ? "M" : "F",
        age: 8 + (i % 4),
        sample: 1, campus: null, retired: false, provisional: false, active: true,
        levels: { matematicas: null, lectura: null },
        createdBy: "sembrar-emulador", createdAt: ahora, updatedAt: ahora,
      });
    }
    await lote.commit();
  }

  for (const c of CUENTAS) {
    await auth.deleteUser(c.uid).catch(() => {}); // así la contraseña siempre queda como dice arriba
    await auth.createUser({ uid: c.uid, email: c.email, password: c.password, displayName: c.fullName });
    await db.collection("users").doc(c.uid).set({
      uid: c.uid, email: c.email, fullName: c.fullName, rol: c.rol, activo: true,
      schoolIds: c.rol === "docente" ? ESCUELAS.map((e) => e.id) : [],
      createdAt: new Date().toISOString(),
    });
  }

  console.log("Emuladores sembrados:");
  ESCUELAS.forEach((e) => console.log(`  ${e.name}: ${e.estudiantes} estudiantes`));
  CUENTAS.forEach((c) => console.log(`  ${c.rol}: ${c.email} / ${c.password}`));
}

main().catch((e) => {
  console.error("No se pudo sembrar. ¿Están encendidos los emuladores?", e.message);
  process.exit(1);
});
