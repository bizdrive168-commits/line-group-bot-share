// ลองคุยกับบอทใน Terminal ก่อนผูก LINE — ใช้คำสั่งประจำตัว (brief.txt) และชื่อบอทจาก .env ชุดเดียวกับของจริง
// ใช้:  npm run chat   (ต้องตั้ง OPENROUTER_API_KEY ใน .env ก่อน)  ·  พิมพ์ "ออก" หรือกด Ctrl+C เพื่อจบ
require('dotenv').config();
const readline = require('readline');
const { chatReply } = require('../src/ai');
const branding = require('../src/branding');
const { say } = branding;
const brief = require('../src/brief');
const { guardNumbers } = require('../src/guard');

if (!process.env.OPENROUTER_API_KEY) {
  console.error('ยังไม่ได้ตั้ง OPENROUTER_API_KEY ในไฟล์ .env — ใส่คีย์ก่อนแล้วลองใหม่');
  process.exit(1);
}

// อ่าน brief.txt ตรงๆ (ไม่ผ่านฐานข้อมูล) — ลองไฟล์ที่เพิ่งแก้ได้ทันที
const local = brief.resolve(process.env);
console.log(`คุยกับ ${branding.BOT} (โหมดลองในเครื่อง ไม่บันทึกลงฐานข้อมูล)`);
console.log(
  local.SOURCE === 'none'
    ? 'ยังไม่มี brief.txt — บอทจะตอบแบบยังไม่รู้ข้อมูลร้าน (ของจริงบอกหน้าที่ผ่านแชท LINE ในโหมดเจ้าของได้)'
    : `ใช้คำสั่งประจำตัว ${local.TEXT.length} ตัวอักษร จาก ${local.SOURCE === 'env' ? 'BOT_BRIEF ใน .env' : 'brief.txt'}`,
);
const left = brief.placeholders(local.TEXT);
if (left.length) console.log(`⚠️  ยังมีช่องที่ไม่ได้กรอก: ${left.join(' ')} — แก้ใน brief.txt ก่อนใช้จริง`);
console.log('พิมพ์ "ออก" เพื่อจบ\n');

const rows = []; // บทสนทนาในหน่วยความจำ — โครงเดียวกับตาราง messages
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'คุณ: ' });
let closed = false;
const prompt = () => {
  if (!closed) rl.prompt();
};

async function handle(line) {
  const text = line.trim();
  if (!text) return prompt();
  if (text === 'ออก' || text === 'exit') return closed || rl.close();
  rows.push({ role: 'user', type: 'text', text, ts: new Date().toISOString() });
  try {
    const raw = (await chatReply(rows, { name: 'ผู้ทดสอบ', briefText: local.TEXT })) || '(ไม่มีคำตอบ)';
    // ผ่านด่านเดียวกับของจริง (src/bot.js) — เห็นแบบที่ลูกค้าจะเห็นจริง
    const guarded = guardNumbers(brief.scrubPlaceholders(raw), [local.TEXT, ...rows.map((r) => r.text)]);
    if (guarded.removed.length) console.log(`\n[ด่าน] ตัดตัวเลขที่ไม่มีในข้อมูลออก: ${guarded.removed.join(', ')}`);
    const answer = say(guarded.text);
    rows.push({ role: 'bot', type: 'text', text: answer, ts: new Date().toISOString() });
    console.log(`\n${branding.BOT}: ${answer}\n`);
  } catch (e) {
    console.error(`\n❌ เรียก AI ไม่สำเร็จ: ${e.message}\n`);
  }
  prompt();
}

// ต่อคิวทีละข้อความ — พิมพ์รัวหรือส่งไฟล์เข้าทาง stdin ก็ตอบครบตามลำดับ และรอคำตอบสุดท้ายก่อนปิด
let queue = Promise.resolve();
rl.prompt();
rl.on('line', (line) => {
  queue = queue.then(() => handle(line));
});
rl.on('close', () => {
  closed = true;
  queue.then(() => process.exit(0));
});
