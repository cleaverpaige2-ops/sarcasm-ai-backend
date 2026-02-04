import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const API_KEY = process.env.GOOGLE_AI_API_KEY;
const ENV_MODEL = process.env.MODEL_NAME?.trim();

if (!API_KEY) {
  console.error("Missing GOOGLE_AI_API_KEY in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

const MODEL_CANDIDATES = [
  ...(ENV_MODEL ? [ENV_MODEL] : []),
  "models/gemini-2.5-flash",
  "models/gemini-2.0-flash",
  "models/gemini-2.0-flash-lite",
  "models/gemini-flash-latest",
  "models/gemini-flash-lite-latest",
  "models/gemini-2.5-pro",
];

let cachedModel = null;
let cachedModelName = null;

/* =========================================================
   STEP 7A — In-memory backend limiter (hard cost ceiling)
   - Uses x-device-id header from client
   - Weekly cap per mode (FREE)
   - Pro bypass can be wired later (x-entitlement: pro)
   ========================================================= */

const LIMITS_FREE_WEEKLY = {
  generator: 3, // Home
  roaster: 3,   // Roaster
  templates: 0, // if you later enable templates, set a cap here (ex: 1)
};

// deviceId|weekKey|mode -> used count
const memUsage = new Map();

function getIsoWeekKeyUTC(d = new Date()) {
  // ISO week key like 2026-W05 (UTC-based)
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const yyyy = date.getUTCFullYear();
  const ww = String(weekNo).padStart(2, "0");
  return `${yyyy}-W${ww}`;
}

function daysUntilNextWeekLocal() {
  const now = new Date();
  const day = now.getDay(); // 0 Sun - 6 Sat
  const daysUntilMonday = (8 - (day === 0 ? 7 : day)) % 7;
  return daysUntilMonday === 0 ? 7 : daysUntilMonday;
}

function getDeviceId(req) {
  // Client should send x-device-id. If missing, we fallback to IP (weaker, but still helps).
  const header = req.headers["x-device-id"];
  if (typeof header === "string" && header.trim()) return header.trim();
  return req.ip || "unknown";
}

function getEntitlement(req) {
  // future: wire real purchases. For now allow a header override.
  // "pro" => unlimited (for testing)
  const v = req.headers["x-entitlement"];
  if (typeof v === "string" && v.toLowerCase().trim() === "pro") return "pro";
  return "free";
}

function enforceWeeklyLimit({ req, mode }) {
  const entitlement = getEntitlement(req);
  if (entitlement === "pro") {
    return { ok: true, remaining: 999999, limit: 999999, used: 0, weekKey: getIsoWeekKeyUTC() };
  }

  const weekKey = getIsoWeekKeyUTC();
  const deviceId = getDeviceId(req);
  const safeMode = mode === "roaster" ? "roaster" : mode === "templates" ? "templates" : "generator";

  const limit = LIMITS_FREE_WEEKLY[safeMode] ?? 0;

  // limit 0 means blocked for free
  if (limit <= 0) {
    return {
      ok: false,
      error: "limit_reached",
      message: "This feature is locked for free users.",
      used: 0,
      limit,
      remaining: 0,
      retryAfterDays: daysUntilNextWeekLocal(),
      weekKey,
    };
  }

  const key = `${deviceId}|${weekKey}|${safeMode}`;
  const used = memUsage.get(key) ?? 0;
  const remaining = Math.max(0, limit - used);

  if (remaining <= 0) {
    return {
      ok: false,
      error: "limit_reached",
      message: `Weekly limit reached for ${safeMode}.`,
      used,
      limit,
      remaining: 0,
      retryAfterDays: daysUntilNextWeekLocal(),
      weekKey,
    };
  }

  // Reserve one usage NOW (so refresh spam can’t slip through)
  memUsage.set(key, used + 1);

  return {
    ok: true,
    used: used + 1,
    limit,
    remaining: Math.max(0, limit - (used + 1)),
    weekKey,
  };
}

/* ========================================================= */

function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function extractUserInput(text) {
  const s = String(text ?? "");
  const marker = "USER INPUT:";
  const idx = s.toUpperCase().indexOf(marker);
  if (idx >= 0) return s.slice(idx + marker.length).trim();
  return s.trim();
}

function profanityRule(allow) {
  return allow
    ? [
        "Profanity: ON (mild-to-moderate allowed if it improves the punchline).",
        "Never use slurs. Never target protected groups. No threats or violence. Avoid explicit sexual content.",
      ].join("\n")
    : "Profanity: OFF. No swearing, no disguised swearing, no censored swears.";
}

function generationFlavor(recipientGen) {
  const g = String(recipientGen || "neutral").toLowerCase();

  switch (g) {
    case "genx":
      return [
        "RECIPIENT GEN FLAVOR: Gen X (strong)",
        "- Tone: dry, deadpan, cynical humor; 'I’ve seen worse' energy.",
        "- Include: one short dry tag like 'Bold.' / 'Sure.' / 'Love that for you.'",
        "- Avoid: heavy modern TikTok slang.",
      ].join("\n");

    case "millennial":
      return [
        "RECIPIENT GEN FLAVOR: Millennial (strong)",
        "- Tone: self-aware sarcasm, witty comparisons, meme-adjacent but readable.",
        "- Include: ONE 'vibe/energy/this could’ve been an email' style phrase (pick one).",
        "- Avoid: trying too hard with Gen Z slang.",
      ].join("\n");

    case "genz":
      return [
        "RECIPIENT GEN FLAVOR: Gen Z (strong)",
        "- Tone: punchy, quick pivots, playful absurdity.",
        "- Include: ONE micro-slang touch MAX if it fits (e.g., 'wild', 'nah', 'okay bestie').",
        "- Avoid: cringe or overused TikTok catchphrases.",
      ].join("\n");

    case "boomer":
      return [
        "RECIPIENT GEN FLAVOR: Boomer (strong)",
        "- Tone: direct, readable, practical punchlines.",
        "- Include: ONE plainspoken idiom (e.g., 'common sense isn’t common').",
        "- Avoid: internet slang.",
      ].join("\n");

    default:
      return [
        "RECIPIENT GEN FLAVOR: Neutral",
        "- Keep it broadly understandable. Use clean idioms and clear punchlines.",
      ].join("\n");
  }
}

function styleProfile(styleId) {
  const s = String(styleId || "light").toLowerCase();

  switch (s) {
    case "worksafe":
      return [
        "HUMOR STYLE: Worksafe / Professional",
        "- Tone: professional sarcasm. Clean, HR-safe.",
        "- Tools: polite wording + subtle dagger + plausible deniability.",
        "- Avoid: profanity, cruelty, anything aggressive.",
      ].join("\n");

    case "dry":
      return [
        "HUMOR STYLE: Dry / Intellectual",
        "- Tone: dry, clever, logical takedowns.",
        "- Include: one smart comparison or logical twist.",
      ].join("\n");

    case "playful":
      return [
        "HUMOR STYLE: Playful",
        "- Tone: teasing, mischievous, friendly roast.",
        "- Tools: exaggeration, silly imagery, warm sarcasm.",
      ].join("\n");

    case "savage":
      return [
        "HUMOR STYLE: Savage",
        "- Tone: sharp, confident, brutal honesty wrapped in comedy.",
        "- Tools: hard punchline, crisp behavior-based insults.",
      ].join("\n");

    case "brainrot":
      return [
        "HUMOR STYLE: Brainrot",
        "- Tone: chaotic internet energy, absurd comparisons, meme-adjacent.",
        "- Tools: unhinged imagery, weird metaphors, playful nonsense.",
        "- Keep it message-ready (not spam).",
      ].join("\n");

    case "southernsass":
    case "southernSass":
      return [
        "HUMOR STYLE: Southern Sass",
        "- Tone: sweet as tea, sharp as a tack. 'Bless your heart' energy.",
        "- Tools: polite phrasing that is secretly a slap.",
      ].join("\n");

    case "light":
    default:
      return [
        "HUMOR STYLE: Light Sarcasm",
        "- Tone: gentle sarcasm, witty but not cruel.",
        "- Tools: mild tease, short punchline.",
      ].join("\n");
  }
}

function levelRules(level) {
  const lvl = clampInt(level, 0, 10);

  if (lvl <= 2) {
    return [
      "LEVEL RULES (0–2):",
      "- Light tease only. One punchline max.",
      "- No harsh insults. No cruelty.",
    ].join("\n");
  }
  if (lvl <= 5) {
    return [
      "LEVEL RULES (3–5):",
      "- Noticeably sarcastic.",
      "- Include ONE vivid comparison (idiom/metaphor).",
    ].join("\n");
  }
  if (lvl <= 8) {
    return [
      "LEVEL RULES (6–8):",
      "- Savage but funny.",
      "- Include TWO devices: (idiom/metaphor) + (absurd imagery/hyperbole).",
      "- Sharper punchline.",
    ].join("\n");
  }
  return [
    "LEVEL RULES (9–10):",
    "- Ruthless + unhinged imagery, still comedic and message-ready.",
    "- Include TWO devices + a final tag/punchline.",
    "- Never threaten violence. Never hateful. No slurs.",
  ].join("\n");
}

function houseRules({ level, allowProfanity, style, recipientGen }) {
  const lvl = clampInt(level, 0, 10);

  return [
    generationFlavor(recipientGen),
    "",
    styleProfile(style),
    "",
    "HOUSE COMEDY DNA:",
    "- Goal: brutal honesty delivered as comedy — 'did I just get verbally slapped… but I laughed.'",
    "- Roast behavior/choices/energy — not protected traits or identity.",
    "- No assistant voice. No advice. No explanations.",
    "- Must be message-ready and quotable.",
    "",
    levelRules(lvl),
    "",
    `Requested level: ${lvl}/10`,
    profanityRule(allowProfanity),
  ].join("\n");
}

function roasterContract() {
  return [
    "ROASTER CONTRACT (MUST FOLLOW):",
    "- You are NOT answering the text.",
    "- You are rewriting what the USER wants to send into a roast-ready outgoing message.",
    "- Write AS THE USER (first-person I/me/my) addressing the other person as 'you'.",
    "- If input is a request/question, rewrite it into a snarky request (do NOT answer it).",
    "- Do NOT say: 'I’d offer', 'I can', 'I will help', 'here’s advice'.",
  ].join("\n");
}

function buildSystemPrompt({ mode, level, allowProfanity, style, recipientGen, count }) {
  if (mode === "roaster") {
    return [
      'You are "The Roaster": a sharp, confident comedy writer.',
      "",
      houseRules({ level, allowProfanity, style, recipientGen }),
      "",
      roasterContract(),
      "",
      "OUTPUT FORMAT:",
      "- Return EXACTLY ONE message.",
      "- 1 sentence preferred, max 2.",
      "- Output ONLY the message. No labels. No quotes. No bullets.",
    ].join("\n");
  }

  if (mode === "templates") {
    return [
      "You generate standalone sarcastic text-message templates.",
      "These are NOT replies to any specific message.",
      "Return short, punchy, sendable messages.",
      "No explanations, no numbering, no bullets.",
      "",
      houseRules({ level, allowProfanity, style, recipientGen }),
      "",
      "OUTPUT FORMAT (STRICT):",
      `- Return EXACTLY ${count} templates.`,
      "- Put each template on ONE LINE.",
      "- Separate using delimiter: |||",
      "- No numbering, no bullets, no labels, no quotes.",
    ].join("\n");
  }

  // HOME mode: force delimiter output so we always get 3
  return [
    "You write message-ready replies to an incoming text message.",
    "",
    houseRules({ level, allowProfanity, style, recipientGen }),
    "",
    "HOME MODE RULES (MUST FOLLOW):",
    "- You ARE replying to the incoming message.",
    "- Every option MUST be sarcastic/funny (no neutral replies).",
    "- Obey the required comedic devices for the chosen level.",
    "- No advice, no explanations, no assistant voice.",
    "",
    "OUTPUT FORMAT (STRICT):",
    `- Return EXACTLY ${count} options.`,
    "- Put each option on ONE LINE.",
    "- Separate options using the delimiter: |||",
    "- No numbering, no bullets, no labels, no quotes.",
    "",
    "Example format:",
    "first option ||| second option ||| third option",
  ].join("\n");
}

function buildUserPrompt({ mode, text, level, allowProfanity }) {
  const raw = extractUserInput(text);
  const lvl = clampInt(level, 0, 10);
  const prof = !!allowProfanity;

  if (mode === "roaster") {
    return [
      "TASK: Rewrite the user's input into ONE outgoing roast message the user would send.",
      "Do NOT answer it. Rewrite it.",
      "",
      "Examples (OUTGOING messages):",
      "INPUT: Can you pick me up at 6?",
      "OUTPUT: Be a hero for once and pick me up at 6—your calendar isn’t that busy, it’s just confused.",
      "",
      "INPUT: You’re so dramatic",
      "OUTPUT: If you cried any harder we’d need a snorkel just to survive this conversation.",
      "",
      "INPUT: K.",
      "OUTPUT: I was gonna reply with 'K' too, but I’m trying to communicate like an adult today—so, okay.",
      "",
      "NOW DO THIS INPUT:",
      `INPUT: ${raw}`,
      "",
      `Constraints: level=${lvl}/10, profanity=${prof ? "ON" : "OFF"}, 1–2 sentences.`,
      "OUTPUT:",
    ].join("\n");
  }

  if (mode === "templates") {
    return [
      "TASK: Generate standalone templates (not replies).",
      `SEED: ${raw}`,
      `Constraints: level=${lvl}/10, profanity=${prof ? "ON" : "OFF"}.`,
    ].join("\n");
  }

  return [
    "TASK: Generate sarcastic replies to the incoming message.",
    `INCOMING: ${raw}`,
    `Constraints: level=${lvl}/10, profanity=${prof ? "ON" : "OFF"}.`,
  ].join("\n");
}

// Robust splitting: first try delimiter, then fallback to lines, then fallback to paragraph split
function splitOptions(generatedText, requestedCount, mode) {
  const c = clampInt(requestedCount, 1, mode === "templates" ? 12 : 3);
  const raw = String(generatedText ?? "").trim();
  if (!raw) return [];

  // Preferred: delimiter for generator/templates
  if (mode !== "roaster" && raw.includes("|||")) {
    const parts = raw
      .split("|||")
      .map((p) => p.trim())
      .filter(Boolean);
    return parts.slice(0, c);
  }

  // Fallback: newline
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^\d+[\).\-\s]+/, "").trim())
    .filter(Boolean);

  if (mode === "roaster") {
    return [lines.length ? lines.join(" ").trim() : raw];
  }

  if (lines.length >= c) return lines.slice(0, c);

  // Fallback: split by sentence-ish separators
  const sentenceish = raw
    .split(/(?<=[.!?])\s+(?=[A-Z“"'])/g)
    .map((s) => s.trim())
    .filter(Boolean);

  // group into 1–2 sentences per option
  const grouped = [];
  for (let i = 0; i < sentenceish.length; i += 2) {
    grouped.push(sentenceish.slice(i, i + 2).join(" "));
  }
  return grouped.slice(0, c);
}

async function getWorkingModel() {
  if (cachedModel) return cachedModel;

  let lastErr = null;
  for (const name of MODEL_CANDIDATES) {
    try {
      const m = genAI.getGenerativeModel({ model: name });
      await m.generateContent("ping");
      cachedModel = m;
      cachedModelName = name;
      console.log(`✅ Using model: ${name}`);
      return cachedModel;
    } catch (e) {
      lastErr = e;
      console.log(`❌ Model failed: ${name} -> ${e?.message || e}`);
    }
  }

  throw new Error(`No working model found. Last error: ${lastErr?.message || String(lastErr)}`);
}

app.get("/health", (_req, res) => res.json({ ok: true, usingModel: cachedModelName }));

app.post("/generate", async (req, res) => {
  try {
    const {
      text,
      style = "light",
      level = 3,
      count = 3,
      allowProfanity = false,
      recipientGen = "neutral",
      mode = "generator",
    } = req.body ?? {};

    // normalize mode
    const safeMode = mode === "roaster" ? "roaster" : mode === "templates" ? "templates" : "generator";

    // ✅ STEP 7A: enforce backend weekly caps (before calling Gemini)
    const limitCheck = enforceWeeklyLimit({ req, mode: safeMode });
    if (!limitCheck.ok) {
      return res.status(429).json(limitCheck);
    }

    const safeLevel = clampInt(level, 0, 10);
    const safeCount =
      safeMode === "roaster" ? 1 : safeMode === "templates" ? clampInt(count, 1, 12) : clampInt(count, 1, 3);

    const inputText = String(text ?? "").trim();
    if (!inputText) return res.status(400).json({ error: "Missing text" });

    const systemPrompt = buildSystemPrompt({
      mode: safeMode,
      level: safeLevel,
      allowProfanity: !!allowProfanity,
      style,
      recipientGen,
      count: safeCount,
    });

    const userPrompt = buildUserPrompt({
      mode: safeMode,
      text: inputText,
      level: safeLevel,
      allowProfanity: !!allowProfanity,
    });

    const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
    const model = await getWorkingModel();

    const generationConfig = {
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: safeMode === "roaster" ? 220 : safeMode === "templates" ? 520 : 420,
    };

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
      generationConfig,
    });

    const out = result?.response?.text?.() ?? "";
    const options = splitOptions(out, safeCount, safeMode);

    if (safeMode === "roaster") {
      const single = (options[0] ?? out.trim() ?? "No response returned.").trim();
      return res.json({
        options: [single],
        usage: { ...limitCheck, mode: safeMode },
      });
    }

    const padded = [...options];
    while (padded.length < safeCount) padded.push("…Try again (refresh) for a stronger roast.");

    return res.json({
      options: padded.slice(0, safeCount),
      usage: { ...limitCheck, mode: safeMode },
    });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({
      error: err?.message ? String(err.message) : "Server error",
      usingModel: cachedModelName,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
