// Platform detection for the Capacitor/Android + PWA dual build.
// On Android (native Capacitor):  isNative() === true
// In browser / Replit preview:    isNative() === false

import { Capacitor } from "@capacitor/core";

export const isNative  = (): boolean => Capacitor.isNativePlatform();
export const isAndroid = (): boolean => Capacitor.getPlatform() === "android";
export const isWeb     = (): boolean => Capacitor.getPlatform() === "web";
