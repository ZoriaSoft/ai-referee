/**
 * Tolerant JSON parsing for files and model output.
 *
 * Accepts (in order): strict JSON → // and block comments → trailing commas.
 * Applied incrementally so valid strict input never sees the sloppy path.
 */
export function parseLooseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to sloppy passes
  }

  const withoutComments = stripJsonComments(text);
  try {
    return JSON.parse(withoutComments);
  } catch {
    // fall through
  }

  return JSON.parse(stripTrailingCommas(withoutComments));
}

/** Removes // and /* *​/ comments, ignoring content inside strings. */
function stripJsonComments(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[++i];
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Removes commas directly followed by } or ], ignoring strings. */
function stripTrailingCommas(text: string): string {
  let out = "";
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\" && i + 1 < text.length) {
        out += text[++i];
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j]!)) j++;
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
