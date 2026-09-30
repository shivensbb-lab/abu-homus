// Build a copy of the game that only uses standard web file types (for static
// hosts and Claude artifacts that refuse .bin / .glb / .hdr):
//   • glTF + .bin  → one self-contained .gltf.json (buffer embedded as base64)
//   • Soldier.glb  → Soldier.gltf.json
//   • sky_2k.hdr   → sky_2k.png (Reinhard tone-mapped, sun stays the brightest texel)
// Usage: node tools/web-build.mjs   → dist-web/
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import * as THREE from 'three';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';

const OUT = 'dist-web';
fs.rmSync(OUT, { recursive: true, force: true });
execSync(`npx vite build --outDir ${OUT} --emptyOutDir`, {
  stdio: 'inherit',
  env: {
    ...process.env,
    VITE_MODEL_EXT: '.gltf.json',
    VITE_CHARACTER_URL: 'assets/models/Soldier.gltf.json',
    VITE_SKY_URL: 'assets/hdri/sky_2k.png',
  },
});

const models = path.join(OUT, 'assets/models');
for (const dir of fs.readdirSync(models)) {
  const d = path.join(models, dir);
  if (!fs.statSync(d).isDirectory()) continue;
  const gltfPath = path.join(d, `${dir}.gltf`);
  const gltf = JSON.parse(fs.readFileSync(gltfPath, 'utf8'));
  for (const b of gltf.buffers) {
    const bin = fs.readFileSync(path.join(d, b.uri));
    fs.rmSync(path.join(d, b.uri));
    b.uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  }
  fs.writeFileSync(`${gltfPath}.json`, JSON.stringify(gltf));
  fs.rmSync(gltfPath);
  console.log('embedded', dir);
}

// GLB → glTF JSON: JSON chunk + BIN chunk as a data URI
{
  const glbPath = path.join(models, 'Soldier.glb');
  const glb = fs.readFileSync(glbPath);
  const jsonLen = glb.readUInt32LE(12);
  const json = JSON.parse(glb.subarray(20, 20 + jsonLen).toString('utf8'));
  const binStart = 20 + jsonLen + 8;
  const binLen = glb.readUInt32LE(20 + jsonLen);
  json.buffers[0].uri = `data:application/octet-stream;base64,${glb.subarray(binStart, binStart + binLen).toString('base64')}`;
  fs.writeFileSync(path.join(models, 'Soldier.gltf.json'), JSON.stringify(json));
  fs.rmSync(glbPath);
  console.log('converted Soldier.glb');
}

// HDR → 8-bit PNG
{
  const hdrPath = path.join(OUT, 'assets/hdri/sky_2k.hdr');
  const buf = fs.readFileSync(hdrPath);
  const loader = new HDRLoader().setDataType(THREE.FloatType);
  const { width, height, data } = loader.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const stride = data.length / (width * height);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  const exposure = 1.6;
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;                          // PNG filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * stride, o = y * (width * 3 + 1) + 1 + x * 3;
      for (let c = 0; c < 3; c++) {
        const v = data[i + c] * exposure;
        const t = v / (1 + v);                              // Reinhard
        raw[o + c] = Math.round(Math.pow(t, 1 / 2.2) * 255);
      }
    }
  }
  fs.writeFileSync(path.join(OUT, 'assets/hdri/sky_2k.png'), png(width, height, raw));
  fs.rmSync(hdrPath);
  console.log('converted sky', width, 'x', height);
}

function png(w, h, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type), body]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
