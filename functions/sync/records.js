const { createHash } = require("node:crypto");

function plain(value) {
    if (value == null) return value;
    if (typeof value.toDate === "function") return value.toDate().toISOString();
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === "object") {
        const result = {};
        for (const key of Object.keys(value).sort()) result[key] = plain(value[key]);
        return result;
    }
    return value;
}
function version(data) {
    return data == null ? null : createHash("sha256").update(JSON.stringify(plain(data))).digest("hex");
}
function record(key, data) {
    return { key, data: plain(data), version: version(data) };
}
function snapshot(doc, key = doc.ref.path) {
    return record(key, doc.exists ? doc.data() : null);
}
module.exports = { plain, version, record, snapshot };
