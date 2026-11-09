// ตัวตนของบอท — ชื่อ / คำแทนตัวเอง / อิโมจิ / คำลงท้าย ตั้งได้จาก .env ที่เดียว
//
//   ไม่ตั้งอะไร             → ใช้ชื่อ LINE Official Account เอง (app.js อ่านตอนบูต) ไม่ต้องกรอกตอนติดตั้ง
//   BOT_NAME=น้องมะลิ      → ตั้งชื่อเองทับชื่อ OA
//   BOT_POLITE=ชาย         → เปลี่ยนคำลงท้ายเป็น ครับ ทั้งบอท
//
// ไฟล์อื่นห้ามฮาร์ดโค้ดชื่อบอทเอง ให้ import จากที่นี่เสมอ
// BOT / SELF เปลี่ยนได้หลังบูต (ชื่อจาก LINE) → ไฟล์อื่นต้องอ่านเป็น branding.BOT ตอนใช้ ห้าม destructure เก็บไว้

// คำแทนตัวเองของบอท — เดาจากชื่อให้อัตโนมัติ ลูกค้าจะได้ตั้งแค่ BOT_NAME ค่าเดียวก็ใช้ได้
// "น้องมะลิ" → เรียกตัวเองว่า "น้อง" / "พี่หมี" → "พี่" / "MayBot" → เรียกชื่อตัวเองเต็ม
function guessSelf(name) {
  for (const prefix of ['น้อง', 'พี่']) {
    if (name.startsWith(prefix) && name.length > prefix.length) return prefix;
  }
  return name;
}

// เปลี่ยนคำลงท้ายผู้หญิง → ผู้ชาย (ใช้เมื่อ BOT_POLITE=ชาย เท่านั้น ค่าเริ่มต้นไม่แตะอะไรเลย)
// ระวัง: "คะ" ไปโผล่กลางคำว่า "คะแนน" ได้ ต้องกันไว้
function toMale(text) {
  return String(text)
    .replace(/ค่ะ/g, 'ครับ')
    .replace(/คะ(?!แนน)/g, 'ครับ')
    .replace(/ครับครับ/g, 'ครับ'); // "นะคะค่ะ" แบบพิมพ์ติดกันจะได้ไม่ซ้ำ
}

// อ่านค่าจาก env (แยกเป็นฟังก์ชันบริสุทธิ์ไว้ให้เทสเรียกได้โดยไม่ต้องยุ่งกับ process.env)
function resolve(env = {}) {
  const name = String(env.BOT_NAME || '').trim() || 'แอดมิน'; // ไม่ได้ตั้ง + อ่านชื่อ OA ไม่ได้
  const male = ['ชาย', 'ผู้ชาย', 'male', 'ครับ'].includes(String(env.BOT_POLITE || '').trim().toLowerCase());
  const say = male ? toMale : (t) => String(t);
  return {
    BOT: name,
    SELF: String(env.BOT_SELF || '').trim() || guessSelf(name),
    EMOJI: String(env.BOT_EMOJI || '').trim() || '💙',
    MALE: male,
    // คำลงท้ายไว้ประกอบ prompt ของ AI
    PARTICLE: male ? 'ครับ' : 'ค่ะ/นะคะ',
    say, // ห่อข้อความก่อนส่งออก — เพศหญิง (ค่าเริ่มต้น) คืนข้อความเดิมไม่แตะ
  };
}

// ชื่อ LINE OA ส่วนใหญ่เป็นชื่อร้าน ("ร้านบ้านมะลิ") → เรียกตัวเองว่า "แอดมิน" ฟังเป็นธรรมชาติกว่าเรียกชื่อร้าน
// ขึ้นต้นด้วย น้อง/พี่ ("น้องมะลิ") ยังเดาแบบเดิม
function selfFromLineName(name) {
  const g = guessSelf(name);
  return g === name ? 'แอดมิน' : g;
}

// ไม่ได้ตั้ง BOT_NAME → ใช้ชื่อ LINE OA ที่ app.js อ่านมาตอนบูต (ตั้ง BOT_NAME ไว้ = ชื่อนั้นชนะเสมอ)
function useLineName(displayName, env = process.env) {
  const name = String(displayName || '').trim();
  if (!name || String(env.BOT_NAME || '').trim()) return false;
  module.exports.BOT = name;
  module.exports.SELF = String(env.BOT_SELF || '').trim() || selfFromLineName(name);
  return true;
}

module.exports = { ...resolve(process.env), resolve, guessSelf, selfFromLineName, toMale, useLineName };
