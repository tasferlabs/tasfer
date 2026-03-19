/**
 * Identity handlers — keypair generation and management.
 * Uses Ed25519 via Node.js crypto.
 */

import { ipcMain } from "electron";
import crypto from "crypto";
import { getDb } from "../db";

function getConfig(key: string): string | null {
  const db = getDb();
  const row = db.prepare("SELECT value FROM config WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function setConfig(key: string, value: string) {
  const db = getDb();
  db.prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(key, value, value);
}

/** Ensure a keypair exists, generate if first run. */
function ensureIdentity(): {
  publicKey: string;
  privateKey: string;
  name: string;
  avatar: string | null;
} {
  let publicKey = getConfig("identity:publicKey");
  let privateKey = getConfig("identity:privateKey");

  if (!publicKey || !privateKey) {
    const keypair = crypto.generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    publicKey = keypair.publicKey.toString("hex");
    privateKey = keypair.privateKey.toString("hex");
    setConfig("identity:publicKey", publicKey);
    setConfig("identity:privateKey", privateKey);
    setConfig("identity:name", "Anonymous");
  }

  return {
    publicKey,
    privateKey,
    name: getConfig("identity:name") ?? "Anonymous",
    avatar: getConfig("identity:avatar"),
  };
}

export function registerIdentityHandlers() {
  ipcMain.handle("identity:get", () => {
    const { publicKey, name, avatar } = ensureIdentity();
    return { publicKey, name, avatar };
  });

  ipcMain.handle(
    "identity:update",
    (_, data: { name?: string; avatar?: string | null }) => {
      ensureIdentity();
      if (data.name !== undefined) setConfig("identity:name", data.name);
      if (data.avatar !== undefined)
        setConfig("identity:avatar", data.avatar ?? "");

      return {
        publicKey: getConfig("identity:publicKey")!,
        name: getConfig("identity:name") ?? "Anonymous",
        avatar: getConfig("identity:avatar") || null,
      };
    },
  );
}
