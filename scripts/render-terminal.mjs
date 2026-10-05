// Renders assets/instagram-monitor-terminal.svg, the terminal shown at the
// top of the README. Every line comes from the CLI's own formatters
// (dist/node/cli.js), so the picture shows exactly what `instagram-monitor run`
// prints; the accounts, posts and numbers are sample data.
//
//   npm run build && npm run render:terminal

import { writeFile } from "node:fs/promises";
import { describeEvent, describePass } from "../dist/node/cli.js";

const at = (hour, minute) => new Date(2026, 9, 2, hour, minute).getTime();
const item = (kind, id, author, text, extra = {}) => ({
  key: `${kind}:${id}`, id, kind, author, text,
  url: kind === "post" ? `https://www.instagram.com/p/${id}/` : `https://www.instagram.com/p/C0dEx1/c/${id}/`,
  ...extra,
});
const found = (time, source, value, urgency, reasons, keywords = []) => ({
  type: "new_item", at: time, account: "acme_shop", source, item: value, keywords, triage: { urgency, score: 0, reasons },
});
const pass = (patch) => ({
  signedIn: true, handle: "acme_shop", loginRequired: false, securityCheck: false, rateLimited: false, requests: 0, sourcesRead: 5,
  baselines: 0, itemsRead: 0, matches: 0, newItems: 0, urgent: 0, commentReads: 0, commentReadsDeferred: 0, followerChecks: 2,
  followerChanges: 0, stopped: false, failed: false, notes: [], ...patch,
});

const lines = [
  describeEvent({ type: "signed_in", at: at(9, 0), handle: "acme_shop" }),
  describePass(pass({ baselines: 5, matches: 7 }), at(9, 0)),
  describeEvent(found(at(9, 15), { kind: "activity", name: "activity" },
    item("comment", "18031", "mila.makes", "@acme_shop my order never arrived, can you check?", { addressed: "mention" }),
    "high", ["Mentions you", 'Says "never arrived"', "Asks a question"])),
  describeEvent(found(at(9, 15), { kind: "own_comments", name: "your posts" },
    item("comment", "18032", "tom_k", "Does the large one ship to Canada?", { addressed: "comment_on_post", replies: 0 }),
    "high", ["Comments on your post", "Asks a question", "No reply yet"])),
  describeEvent(found(at(9, 15), { kind: "profile_comments", name: "@rival_store" },
    item("comment", "18033", "shopper22", "acme does the same thing cheaper, anyone tried?"),
    "low", ["Asks a question"], ["acme"])),
  describeEvent(found(at(9, 15), { kind: "profile_posts", name: "@rival_store" },
    item("post", "C1aB2c", "rival_store", "Summer sale starts today: 30% off everything"),
    "low", [])),
  describePass(pass({ matches: 11, newItems: 4, urgent: 2, commentReads: 2 }), at(9, 15)),
  describeEvent({ type: "followers_changed", at: at(9, 30), handle: "acme_shop", own: true, previous: 12480, current: 12517, delta: 37 }),
  describePass(pass({ matches: 11, followerChanges: 1 }), at(9, 30)),
];

const COLORS = {
  background: "#0b1120",
  bar: "#111827",
  border: "#1f2937",
  text: "#e5e7eb",
  dim: "#6b7280",
  prompt: "#2dd4bf",
  high: "#f87171",
  medium: "#fbbf24",
  low: "#94a3b8",
  counts: "#60a5fa",
  pass: "#94a3b8",
  user: "#c4b5fd",
  reasons: "#a7f3d0",
  up: "#34d399",
  down: "#f87171",
  link: "#64748b",
};

const TOKEN = /(\bHIGH\b|\bMEDIUM\b|(?<=^\s{2})low\b|\bfollowers(?= @)|\bsigned in\b|\bpass(?= @)|@[A-Za-z0-9._]*[A-Za-z0-9_]|https:\/\/\S+|\[[^\]]*\]|\(\+[\d,]+\)|\(-[\d,]+\))/g;

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function colorOf(token) {
  if (token === "HIGH") return COLORS.high;
  if (token === "MEDIUM") return COLORS.medium;
  if (token === "low") return COLORS.low;
  if (token === "followers" || token === "signed in") return COLORS.counts;
  if (token === "pass") return COLORS.pass;
  if (token.startsWith("@")) return COLORS.user;
  if (token.startsWith("https://")) return COLORS.link;
  if (token.startsWith("[")) return COLORS.reasons;
  if (token.startsWith("(+")) return COLORS.up;
  if (token.startsWith("(-")) return COLORS.down;
  return COLORS.dim;
}

function spans(line) {
  const time = line.slice(0, 5);
  const rest = line.slice(5);
  const parts = [`<tspan fill="${COLORS.dim}">${escape(time)}</tspan>`];
  let last = 0;
  for (const match of rest.matchAll(TOKEN)) {
    if (match.index > last) parts.push(escape(rest.slice(last, match.index)));
    parts.push(`<tspan fill="${colorOf(match[0])}">${escape(match[0])}</tspan>`);
    last = match.index + match[0].length;
  }
  parts.push(escape(rest.slice(last)));
  return parts.join("");
}

// An event or a pass carries its details on the lines under it.
const rowsText = lines.flatMap((line) => line.split("\n"));
const FONT_SIZE = 14;
const LINE = 26;
const CHAR = FONT_SIZE * 0.6;
const PAD = 28;
const BAR = 40;
const command = "$ instagram-monitor run --profile acme --keywords acme --profiles rival_store";
const longest = Math.max(command.length, ...rowsText.map((line) => line.length));
const width = Math.ceil(PAD * 2 + longest * CHAR);
const height = BAR + PAD + LINE * (rowsText.length + 1) + PAD - 6;

const rows = [
  `<text x="${PAD}" y="${BAR + PAD + 4}"><tspan fill="${COLORS.prompt}">$</tspan> ${escape(command.slice(2))}</text>`,
  ...rowsText.map((line, index) => `<text x="${PAD}" y="${BAR + PAD + 4 + LINE * (index + 1)}" xml:space="preserve">${spans(line)}</text>`),
];

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Example instagram-monitor output: mentions, comments and competitor posts ranked by urgency, and a follower change">
  <rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="${COLORS.background}" stroke="${COLORS.border}"/>
  <path d="M12.5 0.5h${width - 25}a12 12 0 0 1 12 12v${BAR - 12}h-${width - 1}v-${BAR - 12}a12 12 0 0 1 12-12z" fill="${COLORS.bar}"/>
  <circle cx="24" cy="20" r="6" fill="#ff5f57"/>
  <circle cx="44" cy="20" r="6" fill="#febc2e"/>
  <circle cx="64" cy="20" r="6" fill="#28c840"/>
  <text x="${width / 2}" y="25" text-anchor="middle" fill="${COLORS.dim}" font-family="-apple-system, 'Segoe UI', Helvetica, Arial, sans-serif" font-size="13">instagram-monitor — sample output</text>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace" font-size="${FONT_SIZE}" fill="${COLORS.text}">
    ${rows.join("\n    ")}
  </g>
</svg>
`;

await writeFile(new URL("../assets/instagram-monitor-terminal.svg", import.meta.url), svg);
console.log(`assets/instagram-monitor-terminal.svg: ${width}x${height}, ${rowsText.length} lines`);
