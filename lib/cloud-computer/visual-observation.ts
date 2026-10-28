/** Construct a multimodal message without copying image data into the text. */
export function visualObservation(task: string, page: unknown, currentStep: string, screenshot: unknown) {
  if (typeof screenshot !== 'string' || !screenshot || screenshot.length > 8_000_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(screenshot)) throw new Error('Visual observation unavailable')
  const image = Buffer.from(screenshot, 'base64')
  if (image.length < 3 || image[0] !== 0xff || image[1] !== 0xd8 || image[2] !== 0xff) throw new Error('Invalid visual observation')
  return [{ role: 'user' as const, content: [{ type: 'text' as const, text: JSON.stringify({ task, page, currentStep }) }, { type: 'image' as const, image, mediaType: 'image/jpeg' }] }]
}
