import { describe, expect, it } from "vitest";
import { NATIVE_ORIGIN, PRODUCTION_MOBILE_URL, parseControllerPairingInput, parsePairingInput, trustedMobileUrl } from "./pairing";

describe("untrusted pairing QR", () => {
  const code = "0123456789ABCDEF";
  it("accepts only the selected controller page and a single valid fragment code", () => {
    expect(parsePairingInput(`${PRODUCTION_MOBILE_URL}#pair=${code}`, PRODUCTION_MOBILE_URL)).toEqual({ code, host: "edsionc.top" });
    expect(parsePairingInput(`${PRODUCTION_MOBILE_URL}index.html#pair=${code}`, PRODUCTION_MOBILE_URL).code).toBe(code);
    expect(parsePairingInput(" abcd1234 ", PRODUCTION_MOBILE_URL).code).toBe("ABCD1234");
  });
  it.each([
    `https://evil.example/vivic-remote/#pair=${code}`,
    `https://edsionc.top.evil.example/vivic-remote/#pair=${code}`,
    `https://edsionc.top/other/#pair=${code}`,
    `https://user:secret@edsionc.top/vivic-remote/#pair=${code}`,
    `http://edsionc.top/vivic-remote/#pair=${code}`,
    `${PRODUCTION_MOBILE_URL}?relay=wss://evil.example#pair=${code}`,
    `${PRODUCTION_MOBILE_URL}#pair=${code}&pair=${code}`,
    `${PRODUCTION_MOBILE_URL}#pair=${code}&relay=wss://evil.example`,
    "javascript:alert(1)", "file:///etc/passwd", `${PRODUCTION_MOBILE_URL}#pair=short`,
  ])("rejects %s without navigating", value => {
    expect(() => parsePairingInput(value, PRODUCTION_MOBILE_URL)).toThrow();
  });
  it("pins packaged Android UI to the production controller", () => {
    expect(trustedMobileUrl({ origin: NATIVE_ORIGIN, href: `${NATIVE_ORIGIN}/assets/index.html` })).toBe(PRODUCTION_MOBILE_URL);
  });
  it("allows native online host selection only through an explicit strict pairing URL", () => {
    const native = { origin: NATIVE_ORIGIN, href: `${NATIVE_ORIGIN}/assets/index.html` };
    expect(parseControllerPairingInput(`https://online.vivic.example/remote/#pair=${code}&online=1`, native)).toEqual({
      code, host: "online.vivic.example", transportUrl: "https://online.vivic.example/api/online/mobile/phone",
    });
    for (const value of [
      `http://online.vivic.example/remote/#pair=${code}&online=1`, `https://x:password@online.vivic.example/remote/#pair=${code}&online=1`,
      `https://online.vivic.example/remote/#pair=${code}&online=1&relay=https://evil.example`, `https://online.vivic.example/remote/?key=secret#pair=${code}&online=1`,
      `https://online.vivic.example/api/#pair=${code}&online=1`, `https://online.vivic.example/remote/#pair=${code}&online=1&online=1`,
    ]) expect(() => parseControllerPairingInput(value, native)).toThrow();
  });
  it("same-origin online browser accepts manual codes but rejects a different deployment", () => {
    const location = { origin: "https://online.vivic.example", href: "https://online.vivic.example/remote/" };
    expect(parseControllerPairingInput(code, location)).toMatchObject({ code, transportUrl: `${location.origin}/api/online/mobile/phone` });
    expect(() => parseControllerPairingInput(`https://other.example/remote/#pair=${code}&online=1`, location)).toThrow();
  });
});
