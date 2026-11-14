// Wspolne narzedzia pipeline'u danych: zapis strumieni, statystyki, pomiar zasobow. Bez zaleznosci zewnetrznych.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const R = 6371008.8;
const rad = Math.PI / 180;
export function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
export function dist(values, digits = 1) {
  const s = Float64Array.from(values.filter(Number.isFinite)).sort();
  const r = (x) => (Number.isFinite(x) ? Math.round(x * 10 ** digits) / 10 ** digits : null);
  return {
    n: s.length, min: r(s[0]), p10: r(quantile(s, 0.1)), p50: r(quantile(s, 0.5)), p90: r(quantile(s, 0.9)), p95: r(quantile(s, 0.95)),
    p99: r(quantile(s, 0.99)), p999: r(quantile(s, 0.999)), max: r(s[s.length - 1]), sum: r(s.reduce((a, b) => a + b, 0)),
  };
}
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export class ByteWriter {
  constructor(cap = 1 << 14) {
    this.b = Buffer.allocUnsafe(cap);
    this.n = 0;
  }
  _grow(k) {
    if (this.n + k <= this.b.length) return;
    const nb = Buffer.allocUnsafe(Math.max(this.b.length * 2, this.n + k));
    this.b.copy(nb, 0, 0, this.n);
    this.b = nb;
  }
  byte(v) {
    this._grow(1);
    this.b[this.n++] = v;
  }
  varint(v) {
    this._grow(10);
    let x = v;
    while (x >= 128) {
      this.b[this.n++] = (x % 128) | 128;
      x = Math.floor(x / 128);
    }
    this.b[this.n++] = x;
  }
  zigzag(v) {
    this.varint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  bytes(buf) {
    this._grow(buf.length);
    Buffer.from(buf.buffer, buf.byteOffset, buf.length).copy(this.b, this.n);
    this.n += buf.length;
  }
  done() {
    return this.b.subarray(0, this.n);
  }
}
export function makeReader(buf, start = 0) {
  let q = start;
  return {
    v() {
      let r = 0;
      let mul = 1;
      for (;;) {
        const b = buf[q++];
        r += (b & 127) * mul;
        if (b < 128) return r;
        mul *= 128;
      }
    },
    z() {
      const v = this.v();
      return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
    },
    get pos() {
      return q;
    },
  };
}
export const gzip = (buf) => zlib.gzipSync(buf, { level: 9 });
export const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 1));
}
export const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
// Kontener pliku danych: magia 4 B, u32 dlugosc naglowka JSON, naglowek, potem strumienie sklejone po kolei.
export function packFile(magic, header, streams) {
  const names = Object.keys(streams);
  const lengths = Object.fromEntries(names.map((k) => [k, streams[k].length]));
  const json = Buffer.from(JSON.stringify({ ...header, streams: lengths }), "utf8");
  const pre = Buffer.alloc(8);
  pre.write(magic, 0, "latin1");
  pre.writeUInt32LE(json.length, 4);
  return Buffer.concat([pre, json, ...names.map((k) => Buffer.from(streams[k]))]);
}
export function unpackFile(buf, magic) {
  if (buf.toString("latin1", 0, 4) !== magic) throw new Error(`zla magia pliku, oczekiwano ${magic}`);
  const n = buf.readUInt32LE(4);
  const header = JSON.parse(buf.toString("utf8", 8, 8 + n));
  let p = 8 + n;
  const streams = {};
  for (const [k, l] of Object.entries(header.streams)) {
    streams[k] = buf.subarray(p, p + l);
    p += l;
  }
  if (p !== buf.length) throw new Error(`dlugosc pliku ${buf.length} != ${p}`);
  return { header, streams };
}
// Zapis zasobow procesu na koncu kroku; orkiestrator zbiera z <step>.res.json.
export function reportResources(file, extra = {}) {
  const u = process.resourceUsage();
  writeJson(file, { peakRssMB: Math.round(u.maxRSS / 1024), cpuS: Math.round((u.userCPUTime + u.systemCPUTime) / 1e5) / 10, ...extra });
}
