import { generateText } from "ai";

/** One provider attempt per admission. Durable retries call this function again. */
export async function generatePolicyText(
  admit: () => Promise<unknown>,
  options: Parameters<typeof generateText>[0],
) {
  await admit();
  return generateText({ ...options, maxRetries: 0 });
}
