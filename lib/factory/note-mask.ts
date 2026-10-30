// Masks a human-written Factory note before it is persisted (approval controls,
// task/attempt reason, ledger). Smallest copy of #438's lib/secrets/mask.ts
// createSecretMasker (value + base64/url/hex/JSON forms, longest first) plus the
// factory token patterns (redactFactoryCheckText). Once #438 merges, pass its
// workspaceSecretMasker through `extraSecrets`/replace this with lib/secrets/mask.
import { redactFactoryCheckText } from "./checks";

export const NOTE_MASK_MIN_LENGTH = 8;
/** Server secrets that #438's masker also always masks. */
const SERVER_SECRET_ENV = ["E2B_API_KEY"] as const;
export interface NoteSecret { name: string; value: string }

function forms(value: string): string[] {
  const b64 = Buffer.from(value, "utf8").toString("base64");
  const unpadded = b64.replace(/=+$/, "");
  const urlSafe = unpadded.replaceAll("+", "-").replaceAll("/", "_");
  const hex = Buffer.from(value, "utf8").toString("hex");
  const uri = encodeURIComponent(value);
  // Uppercase hex and lowercase %xx are the same bytes in another spelling.
  return [value, b64, unpadded, urlSafe, uri, uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()), hex, hex.toUpperCase(), JSON.stringify(value).slice(1, -1)];
}

export function serverNoteSecrets(env: NodeJS.ProcessEnv = process.env): NoteSecret[] {
  return SERVER_SECRET_ENV.flatMap((name) => (env[name] ? [{ name, value: env[name]! }] : []));
}

// TODO(#438): double URL encoding, nested JSON escaping, offset base64 (value not
// at a 3-byte boundary), keys split across words, and provider tokens such as
// xoxb-, AKIA and JWTs are left to #438's shared masker.
export function maskFactoryNote(text: string, secrets: readonly NoteSecret[] = serverNoteSecrets()): string {
  const needles = new Map<string, string>();
  for (const { value } of secrets) {
    if ([...value].length < NOTE_MASK_MIN_LENGTH) continue;
    for (const form of forms(value)) if (form.length >= NOTE_MASK_MIN_LENGTH && !needles.has(form)) needles.set(form, "[secret]");
  }
  let out = text;
  for (const [needle, label] of [...needles].sort((a, b) => b[0].length - a[0].length))
    if (out.includes(needle)) out = out.split(needle).join(label);
  // NAME_KEY=value / NAME_TOKEN: value forms the word-boundary patterns miss (E2B_API_KEY=…).
  out = out.replace(/\b([A-Za-z0-9]+_)*[A-Za-z0-9]*(KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*[^\s,;]+/gi, (m) => `${m.split(/[:=]/)[0].trim()}=[REDACTED]`);
  return redactFactoryCheckText(out);
}
