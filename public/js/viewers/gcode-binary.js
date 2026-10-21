// Prusa binary G-code (.bgcode, libbgcode format v1) → plain G-code bytes,
// for the G-code viewer's worker. The file is a 10-byte header (GCDE,
// version, checksum type) and a run of blocks; each block is a header (type,
// compression, sizes), its parameters, its data and a CRC32 when the file has
// checksums. G-code blocks are compressed with Deflate or Heatshrink (window
// 11 or 12, lookahead 4) and encoded with MeatPack (with or without comments).
// The worker imports this module by its own URL (`url`), so it holds no
// state and no DOM access.
export const url = import.meta.url;

const TYPES = ['file metadata', 'G-code', 'slicer metadata', 'printer metadata', 'print metadata', 'thumbnail'];
const PARAMS = [2, 2, 2, 2, 2, 6]; // bytes of block parameters per type
const GCODE = 1;

let table = null;
function crc32(buf, start, end) {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = start; i < end; i++) crc = table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Heatshrink: a bit stream, MSB first. Tag 1 = an 8-bit literal; tag 0 = a
// back-reference of (window bits + 1) bytes back, (lookahead bits + 1) long.
// The window starts as zeros, like the reference decoder.
export function heatshrink(src, size, window, lookahead) {
  const out = new Uint8Array(size);
  let o = 0, p = 0, acc = 0, have = 0;
  const bits = (n) => {
    while (have < n) {
      if (p >= src.length) return -1;
      acc = ((acc << 8) | src[p++]) & 0xFFFFFF;
      have += 8;
    }
    have -= n;
    return (acc >>> have) & ((1 << n) - 1);
  };
  while (o < size) {
    const tag = bits(1);
    if (tag < 0) break;
    if (tag) {
      const b = bits(8);
      if (b < 0) break;
      out[o++] = b;
    } else {
      const index = bits(window);
      const count = index < 0 ? -1 : bits(lookahead);
      if (count < 0) break;
      for (let k = 0, from = o - index - 1; k <= count && o < size; k++, from++) out[o++] = from >= 0 ? out[from] : 0;
    }
  }
  if (o !== size) throw new Error(`Heatshrink data ends after ${o} of ${size} bytes`);
  return out;
}

// MeatPack, as libbgcode's MeatPack::unbinarize: two 4-bit codes per byte for
// the common characters, 0b1111 = a full byte follows, 0xFF 0xFF + a command
// byte switches packing and the no-spaces mode. Spaces left out in G lines
// come back before each parameter letter; empty lines are dropped.
const PACKED = '0123456789. \nGX'.split('').map((c) => c.charCodeAt(0));
const PARAM = new Set('XYZEFIJRSGPWHCA'.split('').map((c) => c.charCodeAt(0)));
const NL = 10, SPACE = 32, G = 71, E = 69;

export function meatpack(src) {
  let out = new Uint8Array(Math.max(64, src.length * 2));
  let n = 0;
  let packing = false, noSpaces = false, command = false, signals = 0, full = 0, held = -1, addSpace = false;

  const put = (c) => {
    if (n + 2 > out.length) { const b = new Uint8Array(out.length * 2); b.set(out); out = b; }
    const last = n ? out[n - 1] : -1;
    let lineStart = false;
    if (c === G && (n === 0 || last === NL)) { addSpace = true; lineStart = true; } else if (c === NL) addSpace = false;
    if (!lineStart && addSpace && (n === 0 || last !== SPACE) && PARAM.has(c)) out[n++] = SPACE;
    if (c !== NL || n === 0 || out[n - 1] !== NL) out[n++] = c;
  };
  const code = (v) => (v === 0b1011 && noSpaces ? E : PACKED[v]);
  const receive = (c) => {
    if (!packing) { put(c); return; }
    if (full > 0) {
      put(c);
      if (held >= 0) { put(held); held = -1; }
      full--;
      return;
    }
    const lowFull = (c & 0x0F) === 0x0F, highFull = (c & 0xF0) === 0xF0;
    if (lowFull) {
      full++;
      if (highFull) full++; else held = code(c >> 4);
    } else {
      const first = code(c & 0x0F);
      put(first);
      if (first !== NL) { if (highFull) full++; else put(code(c >> 4)); }
    }
  };

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 0xFF) {
      if (signals > 0) { command = true; signals = 0; } else signals++;
    } else if (command) {
      if (c === 251) packing = true;
      else if (c === 250 || c === 249) packing = false;
      else if (c === 247) noSpaces = true;
      else if (c === 246) noSpaces = false;
      command = false;
    } else {
      if (signals > 0) { receive(0xFF); signals = 0; }
      receive(c);
    }
  }
  return out.subarray(0, n);
}

async function inflate(src, size) {
  const stream = new Blob([src]).stream().pipeThrough(new DecompressionStream('deflate'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length !== size) throw new Error(`Deflate data gives ${out.length} bytes, the block says ${size}`);
  return out;
}

function uncompress(method, src, size) {
  if (method === 0) return src;
  if (method === 1) return inflate(src, size);
  return heatshrink(src, size, method === 2 ? 11 : 12, 4);
}

// The G-code of a .bgcode as one byte array, at most maxBytes (cut at a line
// end, truncated = true). Every block's CRC32 is checked when the file has
// checksums. Throws an Error whose message says what is wrong and where.
export async function decode(bytes, { maxBytes = Infinity, progress = () => {} } = {}) {
  const n = bytes.length;
  const view = new DataView(bytes.buffer, bytes.byteOffset, n);
  const u16 = (at) => view.getUint16(at, true), u32 = (at) => view.getUint32(at, true);
  if (n < 10 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'GCDE') throw new Error('this is not a binary G-code file (no GCDE header)');
  const version = u32(4), checksum = u16(8);
  if (version !== 1) throw new Error(`binary G-code version ${version} is not supported`);
  if (checksum > 1) throw new Error(`unknown checksum type ${checksum}`);

  const chunks = [];
  let total = 0, truncated = false, blocks = 0, p = 10, nextProgress = 0;
  while (p < n) {
    if (p + 8 > n) throw new Error(`the file ends inside a block header at byte ${p}`);
    const type = u16(p), method = u16(p + 2), size = u32(p + 4);
    if (type >= TYPES.length) throw new Error(`unknown block type ${type} at byte ${p}`);
    if (method > 3) throw new Error(`the ${TYPES[type]} block at byte ${p} uses unknown compression ${method}`);
    const params = p + (method ? 12 : 8);
    if (params > n) throw new Error(`the file ends inside a block header at byte ${p}`);
    const data = params + PARAMS[type];
    const end = data + (method ? u32(p + 8) : size);
    const next = end + (checksum ? 4 : 0);
    if (next > n) throw new Error(`the ${TYPES[type]} block at byte ${p} runs past the end of the file`);
    if (checksum && crc32(bytes, p, end) !== u32(end)) throw new Error(`the ${TYPES[type]} block at byte ${p} fails its CRC32 check: the file is damaged`);
    if (type === GCODE) {
      const encoding = u16(params);
      if (encoding > 2) throw new Error(`the G-code block at byte ${p} uses unknown encoding ${encoding}`);
      if (size > maxBytes) {
        if (!blocks) throw new Error(`the G-code block at byte ${p} is ${size} bytes, above the decode limit`);
        truncated = true;
        break;
      }
      const raw = await uncompress(method, bytes.subarray(data, end), size);
      const text = encoding ? meatpack(raw) : raw;
      blocks++;
      if (total + text.length > maxBytes) {
        let cut = maxBytes - total;
        while (cut > 0 && text[cut - 1] !== NL) cut--;
        chunks.push(text.subarray(0, cut));
        total += cut;
        truncated = true;
        break;
      }
      chunks.push(text);
      total += text.length;
    }
    p = next;
    if (p > nextProgress) { progress(p / n); nextProgress += n / 20; }
  }
  if (!blocks) throw new Error('this binary G-code file holds no G-code block');
  const gcode = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { gcode.set(c, at); at += c.length; }
  return { gcode, truncated };
}
