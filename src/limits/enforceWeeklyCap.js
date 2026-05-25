// src/limits/enforceWeeklyCap.js
import { getWeekKey } from "../week.js";
import { DEV_FLAGS } from "../config/devFlags.js";

export function enforceWeeklyCap({ db }) {
  if (!db) {
    throw new Error("enforceWeeklyCap requires a db instance");
  }

  // middleware
  return async function (req, res, next) {
    try {
      // DEV bypass logic:
      // 1) global bypass env OR 2) header token matches DEV_PRO_TOKEN OR 3) DEV_FLAGS.BYPASS_LIMITS true
      const headerToken = String(req.headers["x-dev-pro"] || req.headers["X-Dev-Pro"] || "").trim();
      const devToken = String(process.env.EXPO_PUBLIC_DEV_PRO_TOKEN || process.env.DEV_PRO_TOKEN || DEV_FLAGS.DEV_PRO_TOKEN || "").trim();

      const bypassByEnv = String(process.env.BYPASS_LIMITS || process.env.EXPO_PUBLIC_DEV_PRO || "").toLowerCase() === "true";
      const bypassByFlag = !!DEV_FLAGS.BYPASS_LIMITS;
      const bypassByHeader = devToken && headerToken && headerToken === devToken;

      if (bypassByEnv || bypassByFlag || bypassByHeader) {
        req.deviceId = req.headers["x-device-id"] || req.body?.deviceId || "dev-pro";
        req.usage = { count: 0, cap: Number(process.env.FREE_WEEKLY_CAP || 9999) };
        // do not increment count when bypassing
        return next();
      }

      // normalize deviceId from header / body / query
      const deviceId =
        String(req.headers["x-device-id"] || req.body?.deviceId || req.query?.deviceId || "").trim();

      if (!deviceId) {
        return res.status(400).json({ ok: false, error: "MISSING_DEVICE_ID" });
      }

      req.deviceId = deviceId;

      const weekId = getWeekKey(new Date());
      const ref = db.collection("usage").doc(deviceId);

      const FREE_WEEKLY_CAP = Number(process.env.FREE_WEEKLY_CAP || 3);

      const result = await db.runTransaction(async (tx) => {
        const snap = await ref.get();
        const data = snap.exists ? snap.data() : {};
        const current = Number(data?.[weekId] || 0);

        if (current >= FREE_WEEKLY_CAP) {
          return { allowed: false, count: current, cap: FREE_WEEKLY_CAP, weekId };
        }

        // increment
        await ref.set({ [weekId]: current + 1 }, { merge: true });
        return { allowed: true, count: current + 1, cap: FREE_WEEKLY_CAP, weekId };
      });

      if (!result.allowed) {
        req.usage = { count: result.count, cap: result.cap };
        return res.status(429).json({
          ok: false,
          error: "WEEKLY_LIMIT_REACHED",
          meta: { count: result.count, cap: result.cap, weekId: result.weekId },
        });
      }

      req.usage = { count: result.count, cap: result.cap };
      return next();
    } catch (err) {
      console.error("enforceWeeklyCap error:", err);
      return res.status(500).json({ ok: false, error: "ENFORCE_CAP_ERROR", detail: String(err) });
    }
  };
}