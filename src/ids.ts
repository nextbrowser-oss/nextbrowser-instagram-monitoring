// Instagram ids. Media and comment ids are wider than a JavaScript number can
// hold exactly, so they are kept as digit strings and never parsed into a
// Number; the page scripts quote them before JSON.parse sees them.
//
// A post's link uses its shortcode, which is the media id written in a base-64
// alphabet. The activity feed names a post by id alone, so the link is
// computed from the id.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const DIGITS = /^\d{1,25}$/;

/** mediaPk takes the id part of a media id: "3254_1234" is media 3254 of user
 *  1234. Anything that is not an id returns "". */
export function mediaPk(id: unknown): string {
  const text = String(id ?? "").trim().split("_")[0] ?? "";
  return DIGITS.test(text) ? text.replace(/^0+(?=\d)/, "") : "";
}

/** shortcodeFromId writes a media id as the shortcode in its link. */
export function shortcodeFromId(id: string): string {
  const pk = mediaPk(id);
  if (!pk) return "";
  let value = BigInt(pk);
  if (value === 0n) return ALPHABET[0]!;
  let code = "";
  while (value > 0n) {
    code = ALPHABET[Number(value % 64n)]! + code;
    value /= 64n;
  }
  return code;
}

/** idFromShortcode reads a shortcode back into the media id. */
export function idFromShortcode(shortcode: string): string {
  let value = 0n;
  for (const char of shortcode.trim()) {
    const digit = ALPHABET.indexOf(char);
    if (digit < 0) return "";
    value = value * 64n + BigInt(digit);
  }
  return shortcode.trim() ? value.toString() : "";
}

/** postUrl is the link to a post. */
export function postUrl(shortcode: string): string {
  return `https://www.instagram.com/p/${shortcode}/`;
}

/** commentUrl is the link to one comment under a post. */
export function commentUrl(shortcode: string, commentId: string): string {
  return `https://www.instagram.com/p/${shortcode}/c/${commentId}/`;
}
