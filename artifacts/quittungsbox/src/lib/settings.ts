// Persistent settings storage.
// On Android: Capacitor Preferences. On web: localStorage.

import { isNative } from "./platform";

const KEY_OPENAI = "openai_api_key";
const KEY_AI_ON  = "ai_enabled";

export async function getOpenAiKey(): Promise<string | null> {
  try {
    if (isNative()) {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key: KEY_OPENAI });
      return value || null;
    }
    return localStorage.getItem(KEY_OPENAI);
  } catch { return null; }
}

export async function setOpenAiKey(key: string | null): Promise<void> {
  try {
    if (isNative()) {
      const { Preferences } = await import("@capacitor/preferences");
      if (key) await Preferences.set({ key: KEY_OPENAI, value: key });
      else      await Preferences.remove({ key: KEY_OPENAI });
    } else {
      if (key) localStorage.setItem(KEY_OPENAI, key);
      else     localStorage.removeItem(KEY_OPENAI);
    }
  } catch { /* ignore */ }
}

export async function isAiEnabled(): Promise<boolean> {
  try {
    if (isNative()) {
      const { Preferences } = await import("@capacitor/preferences");
      const { value } = await Preferences.get({ key: KEY_AI_ON });
      return value !== "false";
    }
    return localStorage.getItem(KEY_AI_ON) !== "false";
  } catch { return true; }
}

export async function setAiEnabled(enabled: boolean): Promise<void> {
  try {
    if (isNative()) {
      const { Preferences } = await import("@capacitor/preferences");
      await Preferences.set({ key: KEY_AI_ON, value: String(enabled) });
    } else {
      localStorage.setItem(KEY_AI_ON, String(enabled));
    }
  } catch { /* ignore */ }
}
