// คำสั่งประจำตัวบอท — เจ้าของเขียนเองว่าบอททำหน้าที่อะไร รู้ข้อมูลอะไร ห้ามทำอะไร
//
// แก้ได้ 2 ทาง อันไหนแก้ทีหลังสุด บอทใช้อันนั้น:
//   1) ไฟล์ brief.txt (ข้างๆ package.json) หรือ BOT_BRIEF ใน .env — อ่านตอนบูต ถ้าไฟล์เปลี่ยนจะกลายเป็นฉบับล่าสุด
//   2) เจ้าของพิมพ์สั่งแก้ในแชท (โหมดเจ้าของ) — บันทึกลงฐานข้อมูลเป็นฉบับใหม่ ใช้ทันทีไม่ต้องรีสตาร์ท
// ทุกฉบับเก็บไว้ในตาราง brief_versions → เจ้าของพิมพ์ "ย้อนกลับ" ได้
const fs = require('fs');
const path = require('path');

// กันคำสั่งยาวจนกิน prompt — ทุกข้อความที่บอทตอบต้องส่งคำสั่งนี้ไปด้วย ยาว = แพงขึ้นทุกครั้ง
const MAX_CHARS = 8000;
const DEFAULT_FILE = path.join(__dirname, '..', 'brief.txt');
// ช่องที่แบบสำเร็จรูปใน briefs/ เว้นไว้ให้กรอก เช่น 〔ชื่อร้าน〕 — ยังเหลือ = เตือน
const PLACEHOLDER = /〔[^〕]*〕/g;

function readBriefFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return ''; // ไม่มีไฟล์ = ไม่มีคำสั่ง
  }
}

// ตัดบรรทัดหมายเหตุ (#) กับบรรทัดว่างเกิน — จดโน้ตไว้ในไฟล์ได้โดยไม่ส่งให้ AI
function clean(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// อ่านจาก .env / ไฟล์ (ฟังก์ชันบริสุทธิ์ รับ env + ตัวอ่านไฟล์ ให้เทสเรียกได้โดยไม่ยุ่งดิสก์จริง)
function resolve(env = {}, { readFile = readBriefFile } = {}) {
  let source = 'none';
  let text = clean(env.BOT_BRIEF);
  if (text) source = 'env';
  else {
    const file = String(env.BOT_BRIEF_FILE || '').trim() || DEFAULT_FILE;
    text = clean(readFile(file));
    if (text) source = 'file';
  }
  let truncated = false;
  if (text.length > MAX_CHARS) {
    text = text.slice(0, MAX_CHARS).trim();
    truncated = true;
  }
  return { TEXT: text, SOURCE: source, TRUNCATED: truncated };
}

function placeholders(text) {
  return [...new Set(String(text || '').match(PLACEHOLDER) || [])];
}

// ฉบับที่ส่งให้ AI ฝั่งลูกค้า: ช่อง 〔...〕 ที่ยังไม่กรอก → "(ยังไม่มีข้อมูล)" ให้ชัดว่าไม่มีจริง
// ทดสอบแล้ว: ส่ง 〔เลขบัญชี〕 ไปตรงๆ โมเดลพิมพ์ให้ลูกค้าเห็น · ตัดบรรทัดทิ้ง โมเดลแต่งเลขบัญชีปลอมขึ้นมาเอง
// โหมดเจ้าของยังเห็น 〔...〕 ครบ จะได้สั่งเติมได้
const UNKNOWN = '(ยังไม่มีข้อมูล)';
function forCustomers(text) {
  return String(text || '').replace(PLACEHOLDER, UNKNOWN);
}
// ด่านสุดท้ายก่อนส่งถึงลูกค้า — หลุดมาก็แทนด้วยคำกลางๆ
// บรรทัดที่หลุดหลายจุด (เช่น "โอนเข้า ? เลขที่ ? ชื่อบัญชี ?") → แทนทั้งบรรทัด อ่านรู้เรื่องกว่า
const PENDING = '(ทางร้านจะแจ้งให้)';
function scrubPlaceholders(text) {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const marked = line.replace(PLACEHOLDER, PENDING).split(UNKNOWN).join(PENDING);
      const hits = marked.split(PENDING).length - 1;
      return hits >= 2 ? 'เรื่องนี้เดี๋ยวทางร้านแจ้งรายละเอียดให้นะคะ' : marked;
    })
    .join('\n');
}

// ก้อนข้อความต่อท้าย system prompt — ไม่มีคำสั่ง = สตริงว่าง
function block(text) {
  return text ? `\n\nคำสั่งจากเจ้าของ — หน้าที่ ข้อมูล และกติกาของคุณ ยึดตามนี้เสมอ:\n${text}` : '';
}

// ตอนบูต: ไฟล์/ .env ไม่ตรงกับฉบับไฟล์ล่าสุดที่จำไว้ = มีคนแก้ไฟล์ → บันทึกเป็นฉบับใหม่ (ชนะของที่แก้ในแชทก่อนหน้า)
// Vercel บูตบ่อย (ทุก cold start) — เขียนเป็นคำสั่งเดียวแบบมีเงื่อนไข สองตัวบูตพร้อมกันก็ไม่ได้ฉบับซ้ำ
async function syncBoot(db = require('./db'), env = process.env, opts) {
  const fromFile = resolve(env, opts);
  if (fromFile.TRUNCATED) console.warn(`⚠️  คำสั่งประจำตัวยาวเกิน ${MAX_CHARS} ตัวอักษร — ตัดส่วนท้ายทิ้ง`);
  if (fromFile.TEXT) await db.addFileBriefIfChanged(fromFile.TEXT);
  const now = await current(db);
  const left = placeholders(now.TEXT);
  if (left.length) console.warn(`⚠️  คำสั่งประจำตัวยังมีช่องที่ไม่ได้กรอก: ${left.join(' ')}`);
  return now;
}

// แบบสำเร็จรูปใน briefs/ — ส่งให้ AI โหมดเจ้าของใช้เป็นโครง ตอนเจ้าของเพิ่งติดตั้งแล้วเล่าว่าอยากให้บอททำอะไร
// เจ้าของจะได้ไม่ต้องเลือกแบบหรือกรอกไฟล์เองตอนติดตั้ง · อ่านไม่ได้ = ไม่มีแบบ (AI ใช้โครง 4 หัวข้อแทน) ไม่ล้ม
const TEMPLATE_DIR = path.join(__dirname, '..', 'briefs');
let cachedTemplates = null;
function templates(dir = TEMPLATE_DIR) {
  if (dir === TEMPLATE_DIR && cachedTemplates) return cachedTemplates;
  let list = [];
  try {
    list = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => {
        const raw = fs.readFileSync(path.join(dir, f), 'utf8');
        const m = raw.split('\n')[0].match(/^#\s*แบบ:\s*(.+?)\s+—/); // "# แบบ: ร้านอาหาร / คาเฟ่ — ..."
        return { file: f, label: m ? m[1].trim() : f.replace(/\.txt$/, ''), text: clean(raw) };
      })
      .filter((t) => t.text);
  } catch {
    list = [];
  }
  if (dir === TEMPLATE_DIR) cachedTemplates = list;
  return list;
}

// ฉบับที่ใช้อยู่ = ฉบับล่าสุดในฐานข้อมูล
async function current(db = require('./db')) {
  const row = await db.latestBrief();
  return row ? { TEXT: row.text, SOURCE: row.source, AT: row.created_at } : { TEXT: '', SOURCE: 'none', AT: null };
}

module.exports = {
  resolve,
  clean,
  block,
  placeholders,
  forCustomers,
  scrubPlaceholders,
  syncBoot,
  current,
  templates,
  MAX_CHARS,
  DEFAULT_FILE,
};
