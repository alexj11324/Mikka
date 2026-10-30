/** SSH belongs to the desktop main process. The browser uses daemon commands. */
export async function POST() {
  return Response.json({ error: 'SSH installation requires the desktop app.' }, { status: 410 })
}
