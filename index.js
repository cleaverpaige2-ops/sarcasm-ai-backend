import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

import { DEV_FLAGS } from "./src/config/devFlags.js";
import { enforceWeeklyCap } from "./src/limits/enforceWeeklyCap.js";
import { db } from "./firebase.js";

dotenv.config();

/* =========================================================
   In-memory DB fallback
   Keeps weekly-cap middleware working without Firebase.
   ========================================================= */
function createInMemoryDb() {
  const store = { usage: {} };

  return {
    collection(name) {
      if (!store[name]) {
        store[name] = {};
      }

      return {
        doc(deviceId) {
          return {
            async get() {
              const bucket = store[name] || {};
              const doc = bucket[deviceId] || {};

              return {
                exists: !!bucket[deviceId],
                data: () => ({ ...doc }),
              };
            },
            async set(obj, opts = {}) {
              const bucket = store[name] || {};
              bucket[deviceId] = {
                ...(opts.merge ? bucket[deviceId] || {} : {}),
                ...obj,
              };
              store[name] = bucket;
            },
          };
        },
      };
    },

    async runTransaction(fn) {
      return fn({
        async get(ref) {
          return ref.get();
        },
        async set(ref, data, opts) {
          return ref.set(data, opts);
        },
      });
    },

    __debug_store: () => store,
  };
}

/* =========================================================
   App + config
   ========================================================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.GOOGLE_AI_API_KEY || "").trim();
const ENV_MODEL = String(process.env.MODEL_NAME || "").trim();

if (!API_KEY) {
  console.error("Missing GOOGLE_AI_API_KEY in .env");
  process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);

const capMiddleware = enforceWeeklyCap({ db });

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

const TEST_CREDITS_CAP = Number(process.env.TEST_CREDITS_CAP || 100);
const FIELD_TEST_DURATION_DAYS = Number(process.env.FIELD_TEST_DURATION_DAYS || 14);

/* =========================================================
   Field test + credits
   ========================================================= */
function addDaysIso(startIso, days) {
  const d = new Date(startIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

async function getFieldTestStatus(db, deviceId) {
  const snap = await db.collection("fieldTest").doc(deviceId).get();
  const data = snap.exists ? snap.data() : {};

  const startedAt = data?.startedAt || null;
  const expiresAt = data?.expiresAt || null;

  if (!startedAt || !expiresAt) {
    return {
      started: false,
      startedAt: null,
      expiresAt: null,
      expired: false,
      daysRemaining: FIELD_TEST_DURATION_DAYS,
    };
  }

  const now = Date.now();
  const expiry = new Date(expiresAt).getTime();
  const msRemaining = expiry - now;
  const daysRemaining = Math.max(0, Math.ceil(msRemaining / 86400000));

  return {
    started: true,
    startedAt,
    expiresAt,
    expired: msRemaining <= 0,
    daysRemaining,
  };
}

async function ensureFieldTestStarted(db, deviceId) {
  const ref = db.collection("fieldTest").doc(deviceId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};

    if (data?.startedAt && data?.expiresAt) {
      const now = Date.now();
      const expiry = new Date(data.expiresAt).getTime();
      const msRemaining = expiry - now;

      return {
        startedAt: data.startedAt,
        expiresAt: data.expiresAt,
        expired: msRemaining <= 0,
        daysRemaining: Math.max(0, Math.ceil(msRemaining / 86400000)),
      };
    }

    const startedAt = new Date().toISOString();
    const expiresAt = addDaysIso(startedAt, FIELD_TEST_DURATION_DAYS);

    await tx.set(
      ref,
      {
        startedAt,
        expiresAt,
        updatedAt: startedAt,
      },
      { merge: true }
    );

    return {
      startedAt,
      expiresAt,
      expired: false,
      daysRemaining: FIELD_TEST_DURATION_DAYS,
    };
  });
}

function requestCostForMode(mode) {
  if (mode === "templates") return 0;
  if (mode === "emoji") return 1;
  if (mode === "roaster") return 1;
  return 3;
}

async function getTestCreditStatus(db, deviceId) {
  const snap = await db.collection("testCredits").doc(deviceId).get();
  const data = snap.exists ? snap.data() : {};
  const used = Number(data?.used || 0);
  const cap = Number(data?.cap || TEST_CREDITS_CAP);
  const remaining = Math.max(0, cap - used);

  return { used, cap, remaining };
}

async function consumeTestCredits(db, deviceId, cost) {
  const ref = db.collection("testCredits").doc(deviceId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const used = Number(data?.used || 0);
    const cap = Number(data?.cap || TEST_CREDITS_CAP);
    const remaining = Math.max(0, cap - used);

    if (cost > remaining) {
      return {
        ok: false,
        used,
        cap,
        remaining,
      };
    }

    const nextUsed = used + cost;
    const nextRemaining = Math.max(0, cap - nextUsed);

    await tx.set(
      ref,
      {
        used: nextUsed,
        cap,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    return {
      ok: true,
      used: nextUsed,
      cap,
      remaining: nextRemaining,
    };
  });
}

/* =========================================================
   MODIFIED UTILITIES & HEURISTICS
   ========================================================= */
function clampInt(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.trunc(x)));
}

function cleanText(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(s) {
  return String(s ?? "").replace(/^["'`\[\({]+|["'`\]\)}]+$/g, "").trim();
}

function normalizeQuestionStem(text) {
  return String(text || "")
    .trim()
    .replace(/[?!.]+$/, "")
    .replace(/\s+/g, " ");
}

function detectWhWord(text) {
  const m = String(text || "")
    .trim()
    .match(/^(what|where|when|who|why|how)\b/i);
  return m ? m[1].toLowerCase() : null;
}

function detectSentenceKind(text) {
  const t = cleanText(text);

  if (!t) return "unknown";
  if (/[?]$/.test(t)) return "question";

  if (/^(do|don't|dont|stop|go|come|leave|give|tell|show|let|please|never)\b/i.test(t)) {
    return "command";
  }

  return "statement";
}

function sentenceKindMismatch(originalText, outputText) {
  const originalKind = detectSentenceKind(originalText);
  const outputKind = detectSentenceKind(outputText);

  if (originalKind === "unknown" || outputKind === "unknown") return false;
  
  // Strict rule: If the original input is a question, ensure the output stays a question structure
  if (originalKind === "question" && outputKind !== "question") return true;
  
  // Give statements and commands more breathing room to cross-pollinate sarcastically without breaking
  return false;
}

function looksTooDifferentFromSource(originalText, outputText) {
  const orig = normalizeQuestionStem(originalText);
  const out = normalizeQuestionStem(outputText);

  if (!orig || !out) return true;

  const origIsQuestion = /[?]$/.test(String(originalText || "").trim());
  const outIsQuestion = /[?]$/.test(String(outputText || "").trim());
  
  // CRITICAL FIX: If the original input is ultra-short (less than 20 characters), 
  // allow the AI to expand the sentence length freely without triggering drift errors.
  if (originalText.length < 20) {
    if (origIsQuestion && !outIsQuestion) return true; // Still enforce question status
    return false; 
  }

  const origWh = detectWhWord(orig);
  const outWh = detectWhWord(out);

  if (origIsQuestion && !outIsQuestion) return true;
  if (origWh && origWh !== outWh) return true;
  if (out.length < Math.max(6, Math.floor(orig.length * 0.35))) return true;

  return false;
}
function uniqStrings(arr) {
  const seen = new Set();
  const out = [];

  for (const item of arr) {
    const value = cleanText(item);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}

function hashString(str) {
  let hash = 0;
  const s = String(str || "");
  for (let i = 0; i < s.length; i += 1) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  return hash >>> 0;
}

function seededPick(pool, seed) {
  if (!Array.isArray(pool) || pool.length === 0) return "";
  return pool[hashString(seed) % pool.length];
}

/* MODIFIED: Improved extraction fallback logic to catch cases where 
  the Lite model leaks the delimiter syntax or wraps things in JSON blocks.
*/
function splitOptions(raw, expectedCount) {
  let text = String(raw ?? "").trim();
  if (!text) return [];

  // Remove markdown code fence blocks if leaked
  text = text.replace(/```json|```text|```/gi, "").trim();

  if (text.includes("|||")) {
    return text
      .split("|||")
      .map((x) => cleanText(stripWrappingQuotes(x)))
      .filter(Boolean)
      .slice(0, expectedCount);
  }

  const lines = text
    .split(/\n+/)
    .map((x) => x.replace(/^\s*[-*•]\s*/, "")) // clear bullets
    .map((x) => x.replace(/^\s*\d+[\).\-\:]\s*/, "")) // clear numbers
    .map((x) => cleanText(stripWrappingQuotes(x)))
    .filter(Boolean);

  if (lines.length > 1) return lines.slice(0, expectedCount);

  return [cleanText(stripWrappingQuotes(text))];
}

function sarcasmToneFrom(style, level) {
  const safeStyle = String(style || "").toLowerCase();
  const safeLevel = clampInt(level, 1, 5);

  if (safeStyle.includes("dry")) return "dry, deadpan sarcasm";
  if (safeStyle.includes("playful")) return "playful sarcasm";
  if (safeStyle.includes("mean")) return "sharp sarcasm";
  if (safeStyle.includes("savage") || safeLevel >= 8) return "cutting, savage sarcasm";
  if (safeLevel <= 3) return "light sarcasm";
  if (safeLevel <= 6) return "dry sarcastic tone";
  return "sharp sarcastic tone";
}

function styleInstruction(style) {
  const s = String(style || "").toLowerCase();

  switch (s) {
    case "dry":
      return "Use dry, deadpan sarcasm. Be brief, understated, and emotionally flat. The humor should come from subtle irony or quiet contradiction, not exaggeration or dramatic phrasing.";
    case "playful":
      return "Use playful sarcasm. Be teasing, witty, and humorous. At low levels keep it light, friendly, and cheeky. Avoid arrogance, insults, or exaggerated superiority unless level is high.";
    case "savage":
      return "Use sharp sarcasm. Be direct and cutting. At low levels keep it restrained and avoid harsh insults. Only become aggressive at higher levels.";
    case "light":
      return "Use very mild sarcasm. Keep it soft, subtle, safe, and friendly. Avoid smugness, exaggeration, dramatic phrasing, and harsh wording.";
    case "worksafe":
      return "Use office-safe sarcasm. Keep it polished, clever, and professional. Avoid slang, chaos, or overly harsh insults.";
    case "brainrot":
      return "Use exaggerated internet-style sarcasm. Be chaotic, hyper-online, and intentionally over-the-top, but still readable.";
    case "southern sass":
    case "southernsass":
      return "Use southern sass. Sound warm, sweet, and polite while subtly delivering a cutting remark.";
    default:
      return "Use natural sarcastic tone.";
  }
}

function levelInstruction(level) {
  const n = clampInt(level, 1, 5);

  if (n === 1) {
    return "Heat 1/5: Just a poke. Use very gentle sarcasm. Keep it friendly, subtle, teasing, and safe for normal conversation.";
  }

  if (n === 2) {
    return "Heat 2/5: Mildly annoyed. Use light sarcasm that is noticeable but still playful, friendly, and socially acceptable.";
  }

  if (n === 3) {
    return "Heat 3/5: Getting heated. Use clear sarcasm. Make it obvious, witty, and slightly sharp without becoming cruel.";
  }

  if (n === 4) {
    return "Heat 4/5: I'm getting pissed. Use strong sarcasm. Be direct, annoyed, and cutting, but avoid threats or graphic wording.";
  }

  return "Heat 5/5: Maximum sarcasm. Be blunt, savage, and unapologetically sharp, but keep it as a text-message comeback and avoid real-world threats.";
}

/* =========================================================
   MODIFIED PROMPT BUILDERS (Data Encapsulation Heuristics)
   ========================================================= */
function buildRoasterPrompt({ text, level, style, nonce }) {
  const safeText = cleanText(text);
  
  return [
    "You are an automated string localization script that injects linguistic irony.",
    "Task: Transform the text inside <source_string> into an aggressively sarcastic equivalent.",
    "Crucial Constraint: The output must remain the exact same type of sentence. If the source string is an inquiry/question, your output MUST be a sarcastic inquiry/question. Do not comment on the text, do not mock an author, and do not write a response to the statement.",
    "",
    "--- MAPPING SAMPLES ---",
    "Source: <source_string>What is 2+2?</source_string>",
    "Target: What legendary mathematical breakthrough could two plus two possibly amount to?",
    "",
    "Source: <source_string>Why is the sky blue?</source_string>",
    "Target: What incredible cosmic mystery causes the sky to opt for a blue hue today?",
    "",
    "Source: <source_string>Pass the salt.</source_string>",
    "Target: Would it absolutely destroy your schedule to pass the salt?",
    "------------------------",
    "",
    "RULES FOR TRANSLATION:",
    `1. ${styleInstruction(style)}`,
    `2. ${levelInstruction(level)}`,
    "3. Maintain the exact structural focus. Do NOT talk about 'a person asking this', do NOT comment on the difficulty, and do NOT use phrases like 'look at this genius'.",
    "4. If the INPUT is a question, the OUTPUT must be a direct sarcastic variant of that exact question.",
    `Configuration: Style=${style}, Intensity=${level}/5, Seed=${String(nonce || Date.now())}`,
    `Source: <source_string>${safeText}</source_string>`,
    "Target:",
  ].join("\n");
}

function buildRoasterRepairPrompt({ originalText, badOutput, level, style, nonce }) {
  const safeOriginal = cleanText(originalText);
  const safeBad = cleanText(badOutput);
  const tone = sarcasmToneFrom(style, level);

  return [
    "You are a text transformation correction utility.",
    "Your previous execution failed because you answered a question or became an AI assistant instead of performing a direct rewrite.",
    "",
    "ORIGINAL BASE STRING:",
    `"${safeOriginal}"`,
    "",
    "YOUR FAILED ANSWER/REPLY:",
    `"${safeBad}"`,
    "",
    "CORRECTION TASK:",
    "Discard your failed answer. Go back to the ORIGINAL BASE STRING.",
    "Rewrite that base string to sound sarcastic. Do NOT give an answer or offer a helpful explanation.",
    `Tone: ${tone}`,
    `Level: ${level}`,
    "",
    "FIXED REWRITE:",
  ].join("\n");
}

function buildGeneratorPrompt({
  text,
  style,
  level,
  count,
  recipientAgeGroup,
}) {
  const safeText = cleanText(text);
  const safeStyle = cleanText(style || "light");
  const safeRecipient = cleanText(recipientAgeGroup || "neutral");
  const tone = sarcasmToneFrom(style, level);

  return [
    `TASK: Generate exactly ${count} sarcastic reply variants to the text message below.`,
    `RECIPIENT TARGET CONTEXT: ${safeRecipient}`,
    "",
    "USER MESSAGE CONTEXT:",
    "===MESSAGE-START===",
    safeText,
    "===MESSAGE-END===",
    "",
    "CRITICAL GENERATION FORMAT RULES:",
    "1. Create original sarcastic text message replies.",
    `2. Separate each unique option using the string delimiter '|||'.`,
    "3. Do not include numbered lists, headers, or conversational introductions.",
    `4. Adhere strictly to the requested style: ${styleInstruction(style)}`,
    `5. Adhere strictly to intensity level: ${levelInstruction(level)}`,
    "",
    "REPLY OPTIONS:",
  ].join("\n");
}
function buildTemplatesPrompt({
  text,
  style,
  level,
  count,
  recipientAgeGroup,
}) {
  const safeText = cleanText(text);
  const safeRecipient = cleanText(recipientAgeGroup || "neutral");

  return [
    `TASK: Generate exactly ${count} reusable sarcastic text-message templates.`,
    `CATEGORY BRIEF: ${safeText}`,
    `AUDIENCE CONTEXT: ${safeRecipient}`,
    "",
    "These are standalone messages the app user can copy and send later.",
    "Do NOT reply to the category brief.",
    "Do NOT mention templates.",
    "Do NOT mention generating content.",
    "Do NOT mention originality.",
    "Do NOT say things like 'you need templates', 'how groundbreaking', or 'my life's work'.",
    "Each option must sound like a real text message someone could send.",
    "Each option must clearly fit the CATEGORY BRIEF.",
    "Use concrete situations from the brief, such as deadlines, meetings, scope creep, late replies, family boundaries, customer support, or chaos depending on the category.",
    "Do not write generic reactions like 'Oh joy', 'sounds fun', 'living the dream', or 'my heart bleeds for you' unless they are attached to a specific situation.",
    "Make every option useful as a copy-ready message.",
    "",
    "STYLE RULES:",
    `${styleInstruction(style)}`,
    `${levelInstruction(level)}`,
    "",
    "FORMAT RULES:",
    `1. Return exactly ${count} options.`,
    "2. Separate each option using only this delimiter: |||",
    "3. No numbering.",
    "4. No bullets.",
    "5. No labels.",
    "6. No explanation.",
    "",
    "GOOD EXAMPLES:",
    "I can do that, but I’ll need this prioritized over the three other things currently on fire.",
    "Happy to help, assuming this deadline was assigned by a calendar and not a haunted vending machine.",
    "I’ll take care of it, right after I finish pretending this meeting could not have been an email.",
    "Per my last email, the answer is still the same, but I appreciate the scenic route back to it.",
    "That sounds like a quick change in the same way moving a house is technically just rearranging furniture.",
    "OUTPUT:",
  ].join("\n");
}
function buildEmojiPrompt({
  text,
  style,
  level,
  recipientAgeGroup,
  nonce,
}) {
  const safeText = cleanText(text);
  const safeRecipient = cleanText(recipientAgeGroup || "neutral");

  return [
    "TASK: Create one sarcastic emoji reaction pack based directly on the user's message, mood, or situation.",
    "",
    "USER INPUT:",
    "===INPUT-START===",
    safeText,
    "===INPUT-END===",
    "",
    `AUDIENCE CONTEXT: ${safeRecipient}`,
    `STYLE: ${styleInstruction(style)}`,
    `HEAT: ${levelInstruction(level)}`,
    `VARIATION SEED: ${String(nonce || Date.now())}`,
    "",
    "CRITICAL RULES:",
    "1. The output must clearly connect to the USER INPUT.",
    "2. Do not use generic emoji reactions unless they fit the input.",
    "3. Use fresh variation each time. Do not repeat the same pack for the same broad topic.",
    "4. Keep it copy-ready for texting.",
    "5. Be sarcastic, funny, and expressive.",
    "6. Do not explain what you are doing.",
    "7. Do not mention prompts, generation, AI, or templates.",
    "8. Avoid threats, slurs, graphic sexual content, or hateful content.",
    "",
    "OUTPUT FORMAT:",
    "Line 1: three to five emojis only",
    "Line 2: three to five emojis only",
    "Line 3: three to five emojis only",
    "Line 4: blank line",
    "Line 5: Reaction: short sarcastic caption connected to the input",
    "Line 6: Soft chaos: short playful sarcastic caption connected to the input",
    "Line 7: Send-and-run: short bolder sarcastic caption connected to the input",
    "",
    "EXAMPLES:",
    "",
    "Input: I need to poop",
    "🚽🏃‍♀️💨",
    "🫡🚪💩",
    "📢🚨🚽",
    "",
    "Reaction: Nature has entered the chat.",
    "Soft chaos: I have been summoned by the porcelain throne.",
    "Send-and-run: This is not a drill. It is a bowel event.",
    "",
    "Input: This meeting could have been an email",
    "📅🙃🔥",
    "📧😐☕",
    "🫠💼🚩",
    "",
    "Reaction: Another calendar hostage situation, love that.",
    "Soft chaos: My inbox could have handled this with less emotional damage.",
    "Send-and-run: This meeting has the energy of an email wearing a fake mustache.",
    "",
    "NOW CREATE THE OUTPUT FOR THE USER INPUT ONLY:",
  ].join("\n");
}
/* =========================================================
   MODIFIED CLEANUP & VALIDATION RULES
   ========================================================= */
function hasPerspectiveShift(originalText, outputText) {
  const orig = cleanText(originalText).toLowerCase();
  const out = cleanText(outputText).toLowerCase();
// If the original is aimed at "you", the rewrite should not flip into
// "I/me" as if the target is replying back.
const originalTargetsYou =
  /\byou\b|\byou're\b|\byou are\b|\byour\b/i.test(orig);

const outputSpeaksAsTarget =
  /^(oh,\s*)?(i'm|i am|i’ve|i have|me|my)\b/i.test(out);

if (originalTargetsYou && outputSpeaksAsTarget) {
  return true;
}
  const originalHasFirstPerson = /\b(i|i'm|i’ve|i'd|me|my|mine)\b/.test(orig);
  const outputHasFirstPerson = /\b(i|i'm|i’ve|i'd|me|my|mine)\b/.test(out);

  if (!originalHasFirstPerson && outputHasFirstPerson) return true;

  const reactionLead = /^(oh|wow|oh wow|well|listen|look|really|seriously)\b/i.test(out);
  if (reactionLead) return false;

  return false;
}

/* MODIFIED: Expanded regex constraints to stop the Lite model from collapsing 
  into "Factual Explainer / Smart Alec Assistant" mode when handled basic inputs.
*/
function looksLikeAnswer(text) {
  const t = cleanText(text).toLowerCase();
  if (!t) return true;

  const explicitAnswerPattern =
    /\b(the password is|the wifi password is|the ssid is|password:\s*|the key is|the code is|the answer is|equals|is four|is 4|because of|due to|refers to|scientific explanation|rayleigh scattering)\b/i;

  const assistantPattern =
    /^(sure|certainly|of course|here you go|i can help|let me help|absolutely|as an ai|here is a sarcastic)\b/i;

  const directInfoPattern =
    /\b(it is|it's)\s+[A-Za-z0-9]/i;

  const longQuotedPattern = /^["'`].{20,}["'`]$/;
  const suspiciousDigitsPattern = /^\d+$/; // single number outputs like "4"

  return (
    explicitAnswerPattern.test(t) ||
    assistantPattern.test(t) ||
    (directInfoPattern.test(t) && t.length < 15) || // catch short simple info drops like "It's blue."
    longQuotedPattern.test(t) ||
    suspiciousDigitsPattern.test(t)
  );
}



function extractRewriteOnly(raw) {
  let text = cleanText(raw);
  if (!text) return "";

  // Strip common label artifacts leaked by smaller models
  text = text.replace(/^(OUTPUT REWRITE|REWRITE|FIXED REWRITE|SARCASTIC REWRITE|REPLY):\s*/i, "");

  const rewriteLabelMatch = text.match(/REWRITE:\s*["']{0,3}([\s\S]+?)["']{0,3}$/i);
  if (rewriteLabelMatch?.[1]) {
    return cleanText(stripWrappingQuotes(rewriteLabelMatch[1]));
  }

  return cleanText(stripWrappingQuotes(text));
}

function cleanRoasterOutput(originalText, rawOutput, level = 5, nonce = "") {
  let single = extractRewriteOnly(rawOutput);

  if (!single) {
    return {
      text: "",
      corrected: true,
      reason: "empty_output",
      needsRepair: true,
    };
  }

  let corrected = false;
  let reason = null;
  let needsRepair = false;

  if (looksLikeAnswer(single)) {
    corrected = true;
    reason = "answer_like_output";
    needsRepair = true;
  }

  if (!corrected && hasPerspectiveShift(originalText, single)) {
    corrected = true;
    reason = "perspective_shift";
    needsRepair = true;
  }

if (!corrected && looksTooDifferentFromSource(originalText, single)) {
    // If it's a short input sentence, give it a pass instead of forcing a broken repair cycle
    if (originalText.length >= 20) {
      corrected = true;
      reason = "structure_drift";
      needsRepair = true;
    }
  }

  if (!corrected && sentenceKindMismatch(originalText, single)) {
    // Only fail if a question turned into a flat statement completely
    if (detectSentenceKind(originalText) === "question" && detectSentenceKind(single) !== "question") {
      corrected = true;
      reason = "sentence_kind_mismatch";
      needsRepair = true;
    }
  }

  single = cleanText(single);

  if (single.length > 200) {
    single = `${single.slice(0, 197).trim()}...`;
    corrected = true;
    reason = reason || "trimmed";
  }

  return {
    text: single,
    corrected,
    reason,
    needsRepair,
  };
}

/* =========================================================
   Generation config + fallbacks
   ========================================================= */
function generationConfigFor({ mode, level }) {
  const safeLevel = clampInt(level, 1, 5);

  if (mode === "roaster") {
    return {
      // Give the model a healthy creative floor so it doesn't choke on low levels
      temperature: Math.min(0.75, 0.5 + safeLevel * 0.04),
      topP: 0.85,
      maxOutputTokens: 175,
    };
  }

  return {
  temperature: mode === "emoji" ? 0.9 : Math.min(0.8, 0.5 + safeLevel * 0.05),
  topP: mode === "emoji" ? 0.95 : 0.85,
  maxOutputTokens: mode === "templates" ? 700 : mode === "emoji" ? 260 : 320,
};
}

function buildGeneratorFallbacks(text, style, level, count) {
  const heat = clampInt(level, 1, 5);

  const mild = [
    "Bold move saying that out loud.",
    "That certainly explains a few things.",
    "Well, that was unexpectedly revealing.",
  ];

  const sharper = [
    "Thanks, that somehow made everything dumber.",
    "Impressive, in a deeply avoidable way.",
    "Amazing how that managed to clarify nothing.",
  ];

  const pool = heat >= 4 ? sharper : mild;
  return uniqStrings(pool).slice(0, count);
}
function cleanEmojiOutput(raw, originalText) {
  let text = String(raw ?? "").trim();

  text = text
    .replace(/```text|```json|```/gi, "")
    .replace(/^\s*OUTPUT:\s*/i, "")
    .trim();

  if (!text) {
    return buildEmojiFallback(originalText);
  }

  const lines = text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line, index, arr) => {
      if (line) return true;
      const before = arr[index - 1]?.trim();
      const after = arr[index + 1]?.trim();
      return !!before && !!after;
    });

  const joined = lines.join("\n").trim();

  if (
    !joined ||
    !/Reaction:/i.test(joined) ||
    !/Soft chaos:/i.test(joined) ||
    !/Send-and-run:/i.test(joined)
  ) {
    return buildEmojiFallback(originalText);
  }

  return joined;
}

function buildEmojiFallback(originalText) {
  const t = cleanText(originalText).toLowerCase();

  if (/\bpoop|bathroom|toilet|pee|piss|stomach|tummy\b/i.test(t)) {
    return [
      "🚽🏃‍♀️💨",
      "🫡🚪💩",
      "📢🚨🚽",
      "",
      "Reaction: Nature has entered the chat.",
      "Soft chaos: I have been summoned by the porcelain throne.",
      "Send-and-run: This is not a drill. It is a bowel event.",
    ].join("\n");
  }

  if (/\bmeeting|email|deadline|work|boss|calendar\b/i.test(t)) {
    return [
      "📅🙃🔥",
      "📧😐☕",
      "🫠💼🚩",
      "",
      "Reaction: Another calendar hostage situation, love that.",
      "Soft chaos: My inbox could have handled this with less emotional damage.",
      "Send-and-run: This meeting has the energy of an email wearing a fake mustache.",
    ].join("\n");
  }

  return [
    "🙃😒🔥",
    "😑🫠🚩",
    "🙄🧨😌",
    "",
    "Reaction: Well, that was certainly a choice.",
    "Soft chaos: I support this emotionally, but only from a safe distance.",
    "Send-and-run: Dropping this here and fleeing the scene immediately.",
  ].join("\n");
}
/* =========================================================
   MODIFIED MODEL SYSTEM INSTRUCTIONS
   ========================================================= */
async function getWorkingModel() {
  if (cachedModel) return cachedModel;

  let lastError = null;

  for (const modelName of MODEL_CANDIDATES) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });

      await model.generateContent({
        contents: [{ role: "user", parts: [{ text: "Reply with: ok" }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 8,
        },
      });

      cachedModel = model;
      cachedModelName = modelName;
      console.log(`Using Gemini model: ${modelName}`);
      return cachedModel;
    } catch (err) {
      lastError = err;
      console.warn(`Model failed: ${modelName} -> ${err?.message || err}`);
    }
  }

  throw new Error(
    `No working Gemini model found. Last error: ${lastError?.message || lastError}`
  );
}

async function generateTextWithModel(prompt, generationConfig, options = {}) {
  let model;
  let targetModelName = null;
  
  // FORCE A SMARTER MODEL FOR THE ROASTER SCREEN
  if (options.isRoaster) {
    // Look for a non-lite candidate inside your array first
    targetModelName = MODEL_CANDIDATES.find(m => m && !m.toLowerCase().includes("lite"));
    if (!targetModelName) {
      targetModelName = "models/gemini-2.5-flash"; // Solid standalone default fallback
    }
  }

  if (targetModelName) {
    try {
      model = genAI.getGenerativeModel({ model: targetModelName });
      // Verify quickly if it works or use cached fallback
      cachedModelName = targetModelName;
    } catch (e) {
      console.warn(`Failed routing directly to smart model ${targetModelName}, falling back...`);
      model = await getWorkingModel();
    }
  } else {
    model = await getWorkingModel();
  }

  /* MODIFIED: Re-engineered system rules to impose explicit behavioral 
    boundaries that small/lite parameters can retain mid-inference.
  */
  const systemInstruction = options.isRoaster
  ? [
      "You are a text-to-text string conversion script. You lack conversational capabilities and cannot interact with users.",
      "Your only function is to convert the user's string into an exaggerated, sarcastically phrased version of the same sentence structure.",
      "CRITICAL: Never break character to comment on the input phrase, mock the user who typed it, or generate conversational dialog. Do not give answers to equations or queries.",
      "Output solely the single line of transformed text."
    ].join("\n")
  : options.isTemplates
  ? [
      "ROLE: You are SarcasmAI's reusable template generator.",
      "TASK: Create standalone sarcastic text messages that a user can copy and send later.",
      "CRITICAL: Do not reply to the prompt or category brief. Do not mention generating, templates, originality, prompts, or the user asking for content.",
      "CONSTRAINT: Outputs must be divided purely by '|||' characters. Do not output anything else."
    ].join("\n")
  : options.isEmoji
    ? [
        "ROLE: You are SarcasmAI's emoji reaction generator.",
        "TASK: Create a sarcastic emoji reaction pack that directly matches the user's input.",
        "CRITICAL: The result must feel specific to the input, not generic.",
        "CONSTRAINT: Output only the requested emoji/caption block. Do not use delimiters, bullets, numbering, explanations, or intro text."
      ].join("\n")
    : [
        "ROLE: You are SarcasmAI, an isolated text-messaging response script.",
        "TASK: Generate raw sarcastic text message choices meant to respond to the provided input parameter.",
        "CONSTRAINT: Outputs must be divided purely by '|||' characters. Do not output anything else."
      ].join("\n");

  // FORCE-CLEAN THE CONFIG TO PREVENT PREMATURE TRUNCATION
  const finalConfig = {
    temperature: Number(generationConfig?.temperature ?? 0.7),
    topP: Number(generationConfig?.topP ?? 0.9),
    maxOutputTokens: options.isRoaster ? 200 : Number(generationConfig?.maxOutputTokens ?? 320),
    stopSequences: [], // <--- PLACED COMMA HERE
    // Disable internal thinking blocks to save the entire token budget for the actual words
    thinkingConfig: {
      thinkingBudget: 0,
    },
  };
  const result = await model.generateContent({
    systemInstruction,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    // Double safeguard: Pass flat config elements explicitly 
    generationConfig: finalConfig,

  });

  const responseText = result?.response?.text?.() ?? "";
  
  // Debug line to see if the model is giving us a finish reason code
  if (options.isRoaster) {
    const candidate = result?.response?.candidates?.[0];
    if (candidate && candidate.finishReason !== "STOP") {
      console.log(`[DEBUG] Gemini Finish Reason: ${candidate.finishReason}`);
    }
  }

  return responseText;
}
/* =========================================================
   Routes
   ========================================================= */
app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "SarcasmAI backend running",
    usingModel: cachedModelName,
  });
});

app.post("/generate", async (req, res) => {
  try {
    await new Promise((resolve) => {
      capMiddleware(req, res, () => resolve());
    });

    if (res.headersSent) return;

    const deviceId =
      req.deviceId ||
      req.headers["x-device-id"] ||
      req.body?.deviceId ||
      "unknown";

    const requestedMode = String(req.body?.mode || "generator").toLowerCase();
const mode =
  requestedMode === "roaster"
    ? "roaster"
    : requestedMode === "templates"
      ? "templates"
      : requestedMode === "emoji"
        ? "emoji"
        : "generator";
    console.log("REQUEST MODE:", req.body?.mode, "->", mode);
    console.log("REQUEST BODY:", req.body);

    const requestCost = requestCostForMode(mode);

    const fieldTestStatus = await getFieldTestStatus(db, deviceId);
    if (fieldTestStatus.started && fieldTestStatus.expired) {
      return res.status(403).json({
        ok: false,
        error: "FIELD_TEST_EXPIRED",
        message: "This field test build has expired.",
        fieldTest: {
          startedAt: fieldTestStatus.startedAt,
          expiresAt: fieldTestStatus.expiresAt,
          daysRemaining: 0,
        },
      });
    }

    const testCredits = await getTestCreditStatus(db, deviceId);
    if (testCredits.remaining < requestCost) {
      return res.status(403).json({
        ok: false,
        error: "TEST_CREDITS_EXHAUSTED",
        message: "You’ve reached the limit for this test version.",
        testCredits: {
          used: testCredits.used,
          cap: testCredits.cap,
          remaining: testCredits.remaining,
          costPerRequest: requestCost,
        },
      });
    }

    const text = cleanText(req.body?.text || "");
    const style = cleanText(req.body?.style || "light");
    const safeLevel = clampInt(req.body?.level, 1, 5);
    const maxCount = mode === "templates" ? 10 : mode === "emoji" ? 1 : 3;
    const requestedCount = clampInt(req.body?.count, 1, maxCount);
    const safeCount = mode === "roaster" || mode === "emoji" ? 1 : requestedCount;
    const recipientAgeGroup = cleanText(req.body?.recipientAgeGroup || "neutral");
    const nonce = req.body?.nonce;

    if (!text) {
      return res.status(400).json({
        ok: false,
        error: "MISSING_TEXT",
      });
    }

    /* -------------------- Roaster -------------------- */
    if (mode === "roaster") {
      const prompt = buildRoasterPrompt({
        text,
        level: safeLevel,
        style,
        nonce,
      });

      const raw = await generateTextWithModel(
        prompt,
        generationConfigFor({ mode, level: safeLevel }),
        { isRoaster: true }
      );

      let cleaned = cleanRoasterOutput(
        text,
        raw,
        safeLevel,
        nonce
      );

      if (cleaned.needsRepair) {
        const repairPrompt = buildRoasterRepairPrompt({
          originalText: text,
          badOutput: raw,
          level: safeLevel,
          style,
          nonce: `${nonce || Date.now()}-repair`,
        });

        const repairedRaw = await generateTextWithModel(
          repairPrompt,
          generationConfigFor({ mode, level: safeLevel }),
          { isRoaster: true }
        );

        const repairedCleaned = cleanRoasterOutput(
          text,
          repairedRaw,
          safeLevel,
          `${nonce || Date.now()}-repair`
        );

        if (!repairedCleaned.needsRepair) {
          cleaned = repairedCleaned;
        }
      }

      if (cleaned.needsRepair) {
        cleaned = {
          text: cleanText(cleaned.text || raw),
          corrected: true,
          reason: "final_repair_passthrough",
          needsRepair: false,
        };
      }

      console.log("ROASTER RAW:", raw);
      console.log("ROASTER CLEANED:", cleaned);

      const creditResult = await consumeTestCredits(db, deviceId, requestCost);
      if (!creditResult.ok) {
        return res.status(403).json({
          ok: false,
          error: "TEST_CREDITS_EXHAUSTED",
          message: "You’ve reached the limit for this test version.",
          testCredits: {
            used: creditResult.used,
            cap: creditResult.cap,
            remaining: creditResult.remaining,
            costPerRequest: requestCost,
          },
        });
      }

      const fieldTestResult = await ensureFieldTestStarted(db, deviceId);
      if (fieldTestResult.expired) {
        return res.status(403).json({
          ok: false,
          error: "FIELD_TEST_EXPIRED",
          message: "This field test build has expired.",
          fieldTest: {
            startedAt: fieldTestResult.startedAt,
            expiresAt: fieldTestResult.expiresAt,
            daysRemaining: 0,
          },
        });
      }

      return res.json({
        ok: true,
        deviceId,
        usage: req.usage || {
          count: 0,
          cap: Number(process.env.FREE_WEEKLY_CAP || 3),
        },
        testCredits: {
          used: creditResult.used,
          cap: creditResult.cap,
          remaining: creditResult.remaining,
          costPerRequest: requestCost,
        },
        fieldTest: {
          startedAt: fieldTestResult.startedAt,
          expiresAt: fieldTestResult.expiresAt,
          daysRemaining: fieldTestResult.daysRemaining,
        },
        options: [cleaned.text],
        debug: {
          devBypassActive:
            !!req.headers["x-dev-pro"] ||
            DEV_FLAGS.BYPASS_LIMITS ||
            String(process.env.BYPASS_LIMITS || "").toLowerCase() === "true",
          roasterCorrected: cleaned.corrected,
          roasterCorrectionReason: cleaned.reason,
          usingModel: cachedModelName,
        },
      });
    }

    /* -------------------- Generator / Home / Templates -------------------- */
const prompt =
  mode === "templates"
    ? buildTemplatesPrompt({
        text,
        style,
        level: safeLevel,
        count: safeCount,
        recipientAgeGroup,
      })
    : mode === "emoji"
      ? buildEmojiPrompt({
          text,
          style,
          level: safeLevel,
          recipientAgeGroup,
          nonce,
        })
      : buildGeneratorPrompt({
          text,
          style,
          level: safeLevel,
          count: safeCount,
          recipientAgeGroup,
        });

    const out = await generateTextWithModel(
  prompt,
  generationConfigFor({ mode, level: safeLevel }),
  { 
    isTemplates: mode === "templates",
    isEmoji: mode === "emoji",
  }
);

   let options =
  mode === "emoji"
    ? [cleanEmojiOutput(out, text)]
    : splitOptions(out, safeCount);

if (mode !== "emoji" && options.length < safeCount) {
  options = uniqStrings([
    ...options,
    ...buildGeneratorFallbacks(text, style, safeLevel, safeCount),
  ]).slice(0, safeCount);
}

    const creditResult = await consumeTestCredits(db, deviceId, requestCost);
    if (!creditResult.ok) {
      return res.status(403).json({
        ok: false,
        error: "TEST_CREDITS_EXHAUSTED",
        message: "You’ve reached the limit for this test version.",
        testCredits: {
          used: creditResult.used,
          cap: creditResult.cap,
          remaining: creditResult.remaining,
          costPerRequest: requestCost,
        },
      });
    }

    const fieldTestResult = await ensureFieldTestStarted(db, deviceId);
    if (fieldTestResult.expired) {
      return res.status(403).json({
        ok: false,
        error: "FIELD_TEST_EXPIRED",
        message: "This field test build has expired.",
        fieldTest: {
          startedAt: fieldTestResult.startedAt,
          expiresAt: fieldTestResult.expiresAt,
          daysRemaining: 0,
        },
      });
    }

    return res.json({
      ok: true,
      deviceId,
      usage: req.usage || {
        count: 0,
        cap: Number(process.env.FREE_WEEKLY_CAP || 3),
      },
      testCredits: {
        used: creditResult.used,
        cap: creditResult.cap,
        remaining: creditResult.remaining,
        costPerRequest: requestCost,
      },
      fieldTest: {
        startedAt: fieldTestResult.startedAt,
        expiresAt: fieldTestResult.expiresAt,
        daysRemaining: fieldTestResult.daysRemaining,
      },
      options: options.slice(0, safeCount),
      debug: {
        devBypassActive:
          !!req.headers["x-dev-pro"] ||
          DEV_FLAGS.BYPASS_LIMITS ||
          String(process.env.BYPASS_LIMITS || "").toLowerCase() === "true",
        usingModel: cachedModelName,
      },
    });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({
      ok: false,
      error: err?.message ? String(err.message) : "Server error",
      usingModel: cachedModelName,
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT} (pid ${process.pid})`);
  console.log(
    `DEV_FLAGS.BYPASS_LIMITS=${DEV_FLAGS.BYPASS_LIMITS}, DEV_PRO_TOKEN=${
      DEV_FLAGS.DEV_PRO_TOKEN ? "<set>" : "<unset>"
    }`
  );
});