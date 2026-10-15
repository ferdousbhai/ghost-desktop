import { randomBytes } from "node:crypto";

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Delimit untrusted content with an identifier in both tags. Exact copies of
 * either marker already present in the payload are escaped before wrapping,
 * so even a deterministic nonce cannot manufacture a nested or early fence.
 */
export function fenceUntrusted(
  content: string,
  opts: { source: string; nonce?: string },
): string {
  const nonce = opts.nonce ?? randomBytes(16).toString("hex");
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(nonce)) {
    throw new TypeError("The untrusted-content nonce must contain only letters, digits, _ or -.");
  }

  const openTag = `<untrusted source="${escapeAttribute(opts.source)}" id="${nonce}">`;
  const closeTag = `</untrusted id="${nonce}">`;
  const neutralized = content
    .replaceAll(openTag, `&lt;untrusted source="${escapeAttribute(opts.source)}" id="${nonce}">`)
    .replaceAll(closeTag, `&lt;/untrusted id="${nonce}">`);

  return `${openTag}\n${neutralized}\n${closeTag}`;
}

export interface InjectionDetection {
  readonly flagged: boolean;
  readonly score: number;
  readonly reasons: string[];
}

export const INJECTION_REASONS = {
  imperativeAiInstruction: "imperative-ai-instruction",
  roleMarkerSpoofing: "role-marker-spoofing",
  toolCallShapedText: "tool-call-shaped-text",
  invisibleOrBidiUnicode: "invisible-or-bidi-unicode",
  largeEncodedBlob: "large-encoded-blob",
} as const;

const IMPERATIVE_AI_PATTERNS = [
  /\b(?:ignore|disregard|forget|override)\s+(?:(?:all|any|the|your)\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|directions?|commands?)\b/i,
  /\b(?:ignore|disregard|override)\s+(?:(?:all|any|the|your)\s+)?(?:instructions?|system message|developer message|safety rules?)\b/i,
  /\bignorez\s+(?:(?:toutes?\s+)?les\s+)?instructions?\s+(?:précédentes?|antérieures?)\b/i,
  /\bignora\s+(?:(?:todas?\s+)?las\s+)?instrucciones?\s+(?:anteriores?|previas?)\b/i,
  /\byou\s+are\s+now\s+(?:(?:an?|the)\s+)?(?:ai|assistant|agent|system|developer|administrator|admin|root|dan|chatgpt|bot)\b/i,
  /\byou\s+are\s+now\s+(?:in\s+)?(?:developer|administrator|admin|debug|sudo|unrestricted)\s+mode\b/i,
  /\b(?:important\s+)?(?:here\s+are\s+)?(?:your\s+)?new\s+instructions?\s*:/i,
  /\b(?:reveal|show|print|repeat|output|leak|expose|return|send|provide)\s+(?:(?:me|us)\s+)?(?:(?:your|the)\s+)?system\s+prompt\b/i,
  /\b(?:your|the)\s+system\s+prompt\s+(?:is|has\s+been|must|should)\b/i,
  /(?:^|[\r\n])\s*system\s+prompt\s*:/im,
] as const;

const ROLE_MARKER_PATTERNS = [
  /(?:^|[\r\n])\s*(?:system|assistant|developer|tool)\s*:/im,
  /<\|[A-Za-z0-9_:-]{1,64}\|>/,
  /\[\s*(?:system|assistant|developer|tool)\s*(?:message)?\s*\]/i,
] as const;

const TOOL_CALL_PATTERNS = [
  /<\s*\/?\s*(?:tool_call|function_call|invoke)(?:\s|>)/i,
  /["'](?:tool|tool_name|function|function_name|name)["']\s*:\s*["'][\w.-]+["'][\s\S]{0,240}["'](?:arguments|args|parameters)["']\s*:/i,
  /["']type["']\s*:\s*["']tool_use["']/i,
  /(?:^|[\r\n])\s*(?:assistant\s+)?(?:to|recipient)\s*=\s*(?:functions?|tools?)[.\w-]*/im,
  /(?:^|[.!?\r\n])\s*(?:please\s+)?(?:call|invoke|execute|run|use)\s+(?:the\s+)?[\w.-]+\s+(?:function|tool)\b/im,
  /(?:^|[.!?\r\n])\s*(?:please\s+)?(?:call|invoke|execute|run|use)\s+(?:the\s+)?(?:function|tool)\s+[\w.-]+\b/im,
] as const;

const ASCII_LOOKALIKE_FOLD: Readonly<Record<string, string>> = {
  // Common Cyrillic lookalikes.
  а: "a",
  е: "e",
  і: "i",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  // Common Greek lookalikes.
  α: "a",
  ε: "e",
  ι: "i",
  κ: "k",
  ο: "o",
  ρ: "p",
  τ: "t",
  ν: "v",
};

const LEETSPEAK_FOLD: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
};

function normalizeForKeywordMatching(content: string): string {
  const folded = content
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[аеіорсхуαεικορτν]/gu, (character) => (
      ASCII_LOOKALIKE_FOLD[character] ?? character
    ))
    .replace(/[013457@]/g, (character) => (
      LEETSPEAK_FOLD[character] ?? character
    ));

  // Join only long runs of individually separated characters. Removing all
  // punctuation or whitespace would turn ordinary prose into keyword matches.
  return folded.replace(
    /(?<![\p{L}\p{N}])(?:[\p{L}\p{N}][\s._-]){3,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu,
    (word) => word.replace(/[\s._-]/g, ""),
  );
}

// Folding intentionally covers only cheap, common Latin lookalikes. Arbitrary
// homoglyphs, languages, and paraphrases are deferred to the opt-in classifier;
// broader deterministic folding creates false positives in ordinary prose.

// Formatting controls that can hide/reorder instructions. Newline and the
// ordinary LTR/RTL letters themselves are intentionally not included.
const SINGLE_INVISIBLE_CODE_POINTS = new Set([
  0x00ad, 0x034f, 0x061c, 0x115f, 0x1160, 0x17b4, 0x17b5, 0x180e, 0xfeff,
]);

function hasInvisibleOrBidiUnicode(content: string): boolean {
  for (const character of content) {
    // Iterating a string yields whole code points, so this is never undefined.
    const codePoint = character.codePointAt(0) as number;
    if (SINGLE_INVISIBLE_CODE_POINTS.has(codePoint)) return true;
    if (codePoint >= 0x200b && codePoint <= 0x200f) return true;
    if (codePoint >= 0x202a && codePoint <= 0x202e) return true;
    if (codePoint >= 0x2060 && codePoint <= 0x206f) return true;
  }
  return false;
}

function hasLargeEncodedBlob(content: string): boolean {
  // Long hex strings are also syntactically base64, so test them first and name
  // the shared reason only once.
  if (/(?:^|[^0-9a-f])[0-9a-f]{120,}(?:$|[^0-9a-f])/i.test(content)) return true;

  for (const match of content.matchAll(/[A-Za-z0-9+/]{152,}={0,2}/g)) {
    const token = match[0];
    if (token.length % 4 !== 0) continue;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(token)) continue;
    return true;
  }
  return false;
}

function matchesAny(content: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(content));
}

/** Deterministic local checks for the known shapes of text aimed at an AI agent. */
export function detectInjection(content: string): InjectionDetection {
  const reasons: string[] = [];
  let score = 0;
  const keywordContent = normalizeForKeywordMatching(content);

  if (matchesAny(keywordContent, IMPERATIVE_AI_PATTERNS)) {
    reasons.push(INJECTION_REASONS.imperativeAiInstruction);
    score += 0.75;
  }
  if (matchesAny(keywordContent, ROLE_MARKER_PATTERNS)) {
    reasons.push(INJECTION_REASONS.roleMarkerSpoofing);
    score += 0.8;
  }
  if (matchesAny(content, TOOL_CALL_PATTERNS)) {
    reasons.push(INJECTION_REASONS.toolCallShapedText);
    score += 0.8;
  }
  if (hasInvisibleOrBidiUnicode(content)) {
    reasons.push(INJECTION_REASONS.invisibleOrBidiUnicode);
    score += 0.7;
  }
  if (hasLargeEncodedBlob(content)) {
    reasons.push(INJECTION_REASONS.largeEncodedBlob);
    score += 0.6;
  }

  return {
    flagged: reasons.length > 0,
    score: Math.min(1, score),
    reasons,
  };
}

