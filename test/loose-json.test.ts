import { describe, expect, it } from "vitest";
import { parseLooseJson } from "../src/loose-json.js";

describe("parseLooseJson", () => {
  it("parses strict JSON", () => {
    expect(parseLooseJson(`{"a":1,"b":[2,3]}`)).toEqual({ a: 1, b: [2, 3] });
  });

  it("strips line comments", () => {
    expect(parseLooseJson(`{"a":1, // one\n"b":2}`)).toEqual({ a: 1, b: 2 });
  });

  it("strips block comments", () => {
    expect(parseLooseJson(`{"a":/* x */1}`)).toEqual({ a: 1 });
  });

  it("strips trailing commas", () => {
    expect(parseLooseJson(`{"a":1,"b":[2,3,],}`)).toEqual({ a: 1, b: [2, 3] });
  });

  it("does not strip // inside strings", () => {
    expect(parseLooseJson(`{"url":"https://example.com"}`)).toEqual({ url: "https://example.com" });
  });

  it("does not strip commas inside strings", () => {
    expect(parseLooseJson(`{"a":"x,}","b":1}`)).toEqual({ a: "x,}", b: 1 });
  });

  it("throws on invalid input", () => {
    expect(() => parseLooseJson("not json")).toThrow();
    expect(() => parseLooseJson(`{"a":}`)).toThrow();
  });
});
