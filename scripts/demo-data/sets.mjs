// The content sets seed.mjs writes: board, threads, devices and the rest from
// content*.mjs, bot chats and the group chat from chats*.mjs. `zh` is the
// default; each set keeps the same keys, so the seed code is shared.

const FILES = {
  zh: ['./content.mjs', './chats.mjs'],
  en: ['./content-en.mjs', './chats-en.mjs'],
}

export async function loadContent(name) {
  const files = FILES[name]
  if (!files) throw new Error(`Unknown content set ${name}; use one of ${Object.keys(FILES).join(', ')}.`)
  const [content, chats] = await Promise.all(files.map(file => import(file)))
  return { ...content, ...chats }
}
