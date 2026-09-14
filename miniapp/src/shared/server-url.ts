// Replaced by the build; no Node environment is read by the phone runtime.
declare const __MENTRA_SERVER_URL__: string | undefined;
export const configuredServerUrl =
  typeof __MENTRA_SERVER_URL__ === "undefined" ? undefined : __MENTRA_SERVER_URL__;
