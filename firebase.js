// firebase.js
import dotenv from "dotenv";
import admin from "firebase-admin";
import path from "path";
import fs from "fs";

// ✅ Ensure .env is loaded BEFORE reading process.env in this module
dotenv.config();

const CREDENTIALS_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim(); // e.g. ./firebase-service-account.json
let PROJECT_ID = process.env.FIREBASE_PROJECT_ID?.trim();

/**
 * @param {string} absPath
 * @returns {object}
 */
function loadServiceAccount(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  return JSON.parse(raw);
}

function resolveAbs(p) {
  return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

if (!admin.apps.length) {
  if (CREDENTIALS_PATH) {
    const abs = resolveAbs(CREDENTIALS_PATH);
    const serviceAccount = loadServiceAccount(abs);

    // ✅ Fallback: service account JSON usually contains project_id
    if (!PROJECT_ID && serviceAccount?.project_id) {
      PROJECT_ID = String(serviceAccount.project_id).trim();
    }

    if (!PROJECT_ID) {
      console.warn(
        "⚠️ FIREBASE_PROJECT_ID is missing and could not be inferred from the service account. Firestore may fail."
      );
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      // projectId is optional if included in credentials, but safe to pass when available
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
  } else {
    // Works only if your environment already has credentials (Cloud Run/Functions).
    if (!PROJECT_ID) {
      console.warn(
        "⚠️ FIREBASE_PROJECT_ID is missing in .env and GOOGLE_APPLICATION_CREDENTIALS is not set. Firestore will likely fail locally."
      );
    }

    admin.initializeApp({
      credential: admin.credential.applicationDefault(),
      ...(PROJECT_ID ? { projectId: PROJECT_ID } : {}),
    });
  }
}

export const db = admin.firestore();
