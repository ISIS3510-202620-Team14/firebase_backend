//Niveles ENAd por materia, de menor a mayor. Se guarda la clave la posición mide el avance.
const NIVELES = {
    matematicas: ["principiante", "un_digito", "dos_digitos", "resta", "division", "problemas"],
    lectura: ["principiante", "letra", "palabra", "parrafo", "cuento", "comprension"]
};

const ETIQUETAS = {
    principiante: "Principiante", 
    un_digito: "Un dígito",
    dos_digitos: "Dos dígitos",
    resta: "Resta",
    division: "División",
    problemas: "Problemas",
    letra: "Letra",
    palabra: "Palabra",
    parrafo: "Párrafo",
    cuento: "Cuento",
    comprension: "Comprensión"
};

const MATERIAS = Object.keys(NIVELES);

//inicial: linea base, media: linea media, final: linea final.
const TIPOS_EVALUACION = ["inicial", "media", "final", "especifica"];

//Enad trabaja con grados de 3 a 5 (posiblemente hay que preguntar)
const GRADOS = [3, 4, 5];

function describirNivel(materia, clave) {
    if(!clave) return null;
    return { clave, etiqueta: ETIQUETAS[clave], orden: NIVELES[materia].indexOf(clave) + 1};
}

module.exports = {
    NIVELES, MATERIAS, TIPOS_EVALUACION, GRADOS, describirNivel
};