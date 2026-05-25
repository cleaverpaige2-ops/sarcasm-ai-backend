// src/config/devFlags.js
export const DEV_FLAGS = {
  BYPASS_LIMITS: String(process.env.EXPO_PUBLIC_DEV_PRO || process.env.BYPASS_LIMITS || "").toLowerCase() === "true",
  DEV_PRO_TOKEN: String(process.env.EXPO_PUBLIC_DEV_PRO_TOKEN || process.env.DEV_PRO_TOKEN || "").trim(),
};