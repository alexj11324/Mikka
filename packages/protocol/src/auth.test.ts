import { describe, expect, it } from "vitest"

import {
  SESSION_COOKIE_NAME,
  mobileTrustedOrigins,
  sessionTokenFromCookie,
} from "./auth"

describe("mobileTrustedOrigins", () => {
  it("trusts the app's scheme always and Expo Go's only in development", () => {
    expect(mobileTrustedOrigins({ isDev: true })).toEqual([
      "mikka://",
      "exp://",
    ])
    expect(mobileTrustedOrigins({ isDev: false })).toEqual(["mikka://"])
  })
})

describe("sessionTokenFromCookie", () => {
  const signed = "tok-1.signature"

  it("reads the signed session value the bearer plugin expects", () => {
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=${signed}`)).toBe(
      signed
    )
  })

  it("picks the session out of the plugin's whole cookie string", () => {
    const cookie = `better-auth.session_data={"session":{}}; ${SESSION_COOKIE_NAME}=${signed}; better-auth.oauth_state=xyz`
    expect(sessionTokenFromCookie(cookie)).toBe(signed)
  })

  it("handles the __Secure- prefix production cookies carry", () => {
    expect(
      sessionTokenFromCookie(`__Secure-${SESSION_COOKIE_NAME}=${signed}`)
    ).toBe(signed)
  })

  it("keeps a value that contains '=' of its own", () => {
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=a=b.c`)).toBe("a=b.c")
  })

  it("is null when there is no session to read", () => {
    expect(sessionTokenFromCookie(null)).toBeNull()
    expect(sessionTokenFromCookie("")).toBeNull()
    expect(sessionTokenFromCookie("better-auth.session_data={}")).toBeNull()
    expect(sessionTokenFromCookie(`${SESSION_COOKIE_NAME}=`)).toBeNull()
  })
})
