export function normalizeAgentUISource(source: string): string {
  // OpenUI falls back to undecoded text if a double-quoted token is not valid JSON.
  return source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"?|'(?:\\[\s\S]|[^'\\])*'?/g, token => {
    if (!token.startsWith('"')) return token
    let result = '"'
    for (let index = 1; index < token.length; index++) {
      const character = token[index]
      if (character === '\\') {
        const next = token[index + 1]
        if (next === undefined) {
          result += character
        } else if (/^["\\/bfnrt]$/.test(next) || next === 'u' && /^[\da-f]{4}/i.test(token.slice(index + 2))) {
          result += character + next
          index++
        } else {
          result += '\\\\'
        }
      } else if (character.charCodeAt(0) < 32) {
        result += JSON.stringify(character).slice(1, -1)
      } else {
        result += character
      }
    }
    return result
  })
}
