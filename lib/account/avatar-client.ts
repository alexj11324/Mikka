/** Shrinks to 256px before upload; the server refuses anything over 200 KB. */
export async function shrinkAvatar(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file)
    const sourceSide = Math.min(bitmap.width, bitmap.height)
    const side = Math.min(sourceSide, 256)
    const canvas = new OffscreenCanvas(side, side)
    const context = canvas.getContext('2d')
    if (!context) { bitmap.close(); return file }
    // Centre crop, so a wide photo is not squashed into an oval.
    context.drawImage(bitmap, (bitmap.width - sourceSide) / 2, (bitmap.height - sourceSide) / 2, sourceSide, sourceSide, 0, 0, side, side)
    bitmap.close()
    return await canvas.convertToBlob({ type: 'image/webp', quality: 0.9 })
  } catch {
    return file
  }
}

