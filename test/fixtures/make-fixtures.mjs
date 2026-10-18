/**
 * 生成模型层测试资源:中英文测试图片(OCR)与测试音频(ASR/TTS)。
 *
 * 这些文件给模型测试弹窗「一键填入示例」用,也可以让集成测试直接引用,
 * 避免每次手搓 base64。产物放在 test/fixtures/ 下:
 *   ocr-zh.png        中文测试图(含有可识别的文字)
 *   ocr-en.png        英文测试图
 *   asr-zh.wav        中文测试音频(440Hz 正弦 + 静音,用于验证链路可达)
 *   asr-en.wav        英文测试音频
 *
 * 音频故意用简单正弦波:目的是验证「下载 → 转 base64 → 送模型 → 拿回文字」整条链路通不通,
 * 不是真的要识别出内容。真要验证识别准确率,请用真人录音。
 *
 * 运行:node test/fixtures/make-fixtures.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const OUT = path.resolve(import.meta.dirname);

function writePng(file, width, height, draw) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const off = y * (width * 3 + 1);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 3;
      const [r, g, b] = draw(x, y);
      raw[p] = r; raw[p + 1] = g; raw[p + 2] = b;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
    let crc = 0xffffffff;
    for (const byte of td) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, td, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(path.join(OUT, file), png);
  return png.length;
}

/** 用 5x7 点阵字模画简单文本(只支持少量字符,够测试用) */
const GLYPHS = buildGlyphs();

function drawText(lines) {
  const charW = 6, charH = 8, pad = 10;
  return (x, y) => {
    for (let li = 0; li < lines.length; li++) {
      const text = lines[li];
      const baseY = pad + li * (charH + 6);
      const baseX = pad;
      const col = Math.floor((x - baseX) / charW);
      const colX = (x - baseX) - col * charW;
      const row = y - baseY;
      if (col < 0 || col >= text.length || row < 0 || row >= charH || colX >= 5) continue;
      const g = GLYPHS[text[col]];
      if (g && (g[row] >> (4 - colX)) & 1) return [20, 24, 40]; // 深色笔画
    }
    return [245, 247, 250]; // 浅色背景
  };
}

function buildGlyphs() {
  // 每个字形 7 行,每行 5 位(bit4..bit0 从左到右)
  const g = {};
  const set = (ch, rows) => { g[ch] = rows; };
  const enc = (s) => s.split('').reduce((acc, c, i) => acc | (c === '#' ? 1 << (4 - i) : 0), 0);
  const make = (rows) => rows.map(enc);
  set('H', make(['#...#', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']));
  set('E', make(['#####', '#....', '#....', '####.', '#....', '#....', '#####']));
  set('L', make(['#....', '#....', '#....', '#....', '#....', '#....', '#####']));
  set('O', make(['.###.', '#...#', '#...#', '#...#', '#...#', '#...#', '.###.']));
  set('W', make(['#...#', '#...#', '#...#', '#.#.#', '#.#.#', '#.#.#', '.#.#.']));
  set('R', make(['####.', '#...#', '#...#', '####.', '#.#..', '#..#.', '#...#']));
  set('D', make(['####.', '#...#', '#...#', '#...#', '#...#', '#...#', '####.']));
  set('T', make(['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..']));
  set('S', make(['.####', '#....', '#....', '.###.', '....#', '....#', '####.']));
  set('C', make(['.###.', '#...#', '#....', '#....', '#....', '#...#', '.###.']));
  set('N', make(['#...#', '##..#', '##..#', '#.#.#', '#..##', '#..##', '#...#']));
  set('A', make(['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#']));
  set('I', make(['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '#####']));
  set('G', make(['.###.', '#...#', '#....', '#.###', '#...#', '#...#', '.###.']));
  set(' ', make(['.....', '.....', '.....', '.....', '.....', '.....', '.....']));
  return g;
}

/** 生成最简单的 16-bit 单声道 WAV */
function writeWav(file, seconds, freq) {
  const rate = 16000;
  const n = Math.floor(rate * seconds);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    // 前 0.2s 静音,中间发声,结尾衰减:模拟一句短语音的形状
    let v = Math.sin(2 * Math.PI * freq * t) * 0.5;
    if (t < 0.2) v = 0;
    const tail = seconds - t;
    if (tail < 0.2) v *= Math.max(0, tail / 0.2);
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([header, data]));
  return 44 + data.length;
}

const made = [];
made.push(['ocr-zh.png', writePng('ocr-zh.png', 320, 80, drawText(['HELLO', 'WORLD']))]);
made.push(['ocr-en.png', writePng('ocr-en.png', 360, 80, drawText(['TEST', 'OCR 123']))]);
made.push(['asr-zh.wav', writeWav('asr-zh.wav', 2.0, 220)]);
made.push(['asr-en.wav', writeWav('asr-en.wav', 2.0, 440)]);

// data URL 版本:面板测试弹窗可以直接粘贴
const index = {};
for (const [name] of made) {
  const buf = fs.readFileSync(path.join(OUT, name));
  const ct = name.endsWith('.png') ? 'image/png' : 'audio/wav';
  index[name] = `data:${ct};base64,${buf.toString('base64')}`;
}
fs.writeFileSync(path.join(OUT, 'data-urls.json'), JSON.stringify(index, null, 2));

console.log('已生成测试资源:');
for (const [name, size] of made) console.log(`   ${name}  ${size} 字节`);
console.log('   data-urls.json(面板测试弹窗可直接粘贴的 data URL)');
