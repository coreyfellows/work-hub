// The one prompt a generation job sends (headless `claude -p`, no tools). It asks for one JSON object; generate.ts
// parses, sanitizes and validates the answer, so the prompt only has to make a good answer likely.
import type { Character } from './cast.ts';
import { EASINGS, ORIGINS } from './keyframes.ts';

export type Part = 'all' | 'portrait' | 'lines' | 'motion';

export interface GenRequest {
  named: string;
  kind: 'play' | 'inspired';
  part: Part;
  feedback?: string;
  /** The character being regenerated (absent when adding). */
  id?: string;
}

/** Which answer keys each part asks for (the server merges only these into the character). */
export const PART_KEYS: Record<Part, string[]> = {
  all: ['name', 'emoji', 'voice', 'badge', 'asks', 'spinner', 'color', 'palette', 'mode', 'portrait', 'motion'],
  lines: ['voice', 'badge', 'asks', 'spinner'],
  portrait: ['color', 'palette', 'mode', 'portrait'],
  motion: ['motion'],
};

const RULES = `Rules (all of them, always):
- Everything you write is original: never quote films, shows, books, songs or interviews, and never reuse a catchphrase verbatim; write new lines in the spirit of the character.
- The portrait is a simple flat cartoon, not a likeness of any photograph or real image.
- Real public figures may be played only as gentle, affectionate parody: no political attacks, no mockery of looks, beliefs or identity, nothing demeaning. Never play private individuals.
- If you won't do this character as asked, answer exactly {"declined": "<one short reason>"} and nothing else. Do not water the character down instead.
- Keep it light and fun. It's a host that comments on someone's coding sessions.`;

const LINES = `Lines:
- "voice": 2–4 sentences on how this host talks and what they're like, written as instructions to a model that will write one-line asides in their voice (≤ 600 characters). End with "Write original lines, never long quotes."
- "asks": 4–8 lines the host says above a question it needs answered (≤ 40 characters each, in voice).
- "spinner": 6–12 short phrases for what the host is doing while work runs, like "Polishing the lens" (≤ 40 characters each).
- "badge" (optional): a tiny label shown before the host's name, ≤ 12 characters (e.g. "● ON AIR"); leave it out unless it really fits.`;

const LOOK = `Look:
- "color": the host's main colour, "#rrggbb".
- "palette": { "letters": 2–8 "#rrggbb" for the name's gradient, "borderColors": 1–8 "#rrggbb" for the card's border, "text": "#rrggbb" readable on #15171c, "trim" (optional): a short decorative ASCII/Unicode line ≤ 40 characters scrolled above the card (e.g. "═══ ⌁ ═══ ⌁ "), "trimColors" (optional): 1–8 "#rrggbb" }.
- "mode": how the card moves: "wave" (name slides, trim ticks), "marquee" (faster), "fade" (slow drift), "flicker" (a dying neon sign), "stack" (the portrait wobbles), "still" (lowercase, no motion).
- "portrait": { "svg": "<the portrait's SVG elements as one string>" } in a 64×64 viewBox (no <svg> wrapper). The app animates it through rig marks set with class:
  - class="brows": one <g> with both eyebrows (they raise, furrow and cock).
  - class="eyes": one <g> with both eyes (they glance around and blink). Use class="shades" instead for eyes hidden behind sunglasses, or "eyes-noblink" for eyes that shouldn't blink.
  - class="mouth": one <g> holding exactly three children <g class="mouth-rest">, <g class="mouth-smile"> and <g class="mouth-o"> (a surprised "o"); one shows at a time, so draw all three in the same spot.
  - class="prop1" and optionally class="prop2": one element or <g> each that moves on its own (a hat that tips, a cup that's sipped, a sign that flickers). Its loop is in "motion.props".
  - Layout: fill the square with a background (a <rect width="64" height="64">); the head is around (32, 28), radius ≈ 12–14; shoulders and body below to the bottom edge; the face's features sit between y 20 and 42. It's clipped to a circle, so keep important things within 30 of the centre.
  - Allowed elements only: g, path, circle, ellipse, rect, line, polyline, polygon, defs, linearGradient, radialGradient, stop. Allowed attributes only: d, cx, cy, r, rx, ry, x, y, x1, y1, x2, y2, width, height, points, fill, stroke, stroke-width, stroke-linecap, stroke-linejoin, fill-rule, opacity, fill-opacity, stroke-opacity, transform (translate/rotate/scale/skewX/skewY only), id and offset/stop-color/stop-opacity/gradientUnits/gradientTransform/fx/fy on gradients, and class with the rig marks above. Colours as "#rrggbb", "none" or url(#id) of a gradient you define. No style, text, images, use, scripts, comments or entities. Numbers between -64 and 128, no exponents. At most 400 elements and 8 KB of path data.
  - Example of the shape (a plain face, nothing like what you'll draw): <rect width="64" height="64" fill="#2b2d42"/><path d="M6 64 C8 50 20 46 32 46 C44 46 56 50 58 64 Z" fill="#8d99ae"/><ellipse cx="32" cy="28" rx="12" ry="14" fill="#f1c27d"/><g class="brows"><path d="M24 22 Q27 21 30 22 M34 22 Q37 21 40 22" stroke="#3d2b1f" stroke-width="1.4" fill="none" stroke-linecap="round"/></g><g class="eyes"><circle cx="27" cy="27" r="1.6" fill="#1f1a17"/><circle cx="37" cy="27" r="1.6" fill="#1f1a17"/></g><g class="mouth"><g class="mouth-rest"><path d="M29 37 Q32 39 35 37" stroke="#1f1a17" stroke-width="1.1" fill="none"/></g><g class="mouth-smile"><path d="M28 36.5 Q32 41 36 36.5" stroke="#1f1a17" stroke-width="1.3" fill="none"/></g><g class="mouth-o"><ellipse cx="32" cy="38" rx="1.3" ry="1.6" fill="#1f1a17"/></g></g><g class="prop1"><path d="M20 15 L44 15 L40 6 L24 6 Z" fill="#ef233c"/></g>
  - "ampCap" (optional, 0.5–3, next to "svg"): when the eyes sit inside a frame (glasses, a visor), how far they may travel; leave out otherwise.`;

const MOTION = `Motion:
- "motion": { "exit": <keyframes>, "props": [<keyframes for prop1>, <keyframes for prop2>] } ("props" only for the props the portrait has).
- "exit" plays when the host's card leaves the screen, in a way that fits the character (drives off, fades into a rug, a TV switching off…): "durationMs" 800–2500, and the last frame must have "opacity": 0.
- A prop loop: "durationMs" 800–8000, repeating forever; mostly still with a short move is best.
- <keyframes> = { "durationMs": n, "easing": one of ${EASINGS.map((e) => `"${e}"`).join(', ')} (optional), "frames": [ { "at": 0–100 (strictly increasing, first 0, last 100), "transform": "<CSS transform>" (optional), "opacity": 0–1 (optional), "filter": "<CSS filter>" (optional), "transformOrigin": one of ${ORIGINS.map((o) => `"${o}"`).join(', ')} (optional, on the first frame) } ] } with 2–20 frames.
- Transforms: translate/translateX/translateY (px or %, ±200), rotate (deg, ±720), scale/scaleX/scaleY (0–4), skew/skewX/skewY (deg, ±60), or "none". Filters: blur (px, 0–20), brightness, saturate, sepia (0–8), grayscale (0–1), hue-rotate (deg, ±360), or "none".`;

function describe(c: Character): string {
  return [
    `Name: ${c.name}. Emoji: ${c.emoji}. ${c.origin.kind === 'play' ? `Plays ${c.origin.named}.` : `Inspired by ${c.origin.named}.`}`,
    `Voice: ${c.voice}`,
    `Colour ${c.color}, mode "${c.mode}".`,
    `Props in the portrait: ${['prop1', 'prop2'].filter((p) => JSON.stringify(c.portrait.nodes).includes(`"class":"${p}"`)).join(', ') || 'none'}.`,
  ].join('\n');
}

/** The prompt for one generation: a new character (`current` absent) or one part of an existing one. */
export function buildPrompt(req: GenRequest, cast: Character[], current?: Character): string {
  const keys = PART_KEYS[req.part];
  const others = cast.filter((c) => c.id !== req.id);
  const who =
    req.kind === 'play'
      ? `The host IS ${req.named}: use their name (as people know them) and play them in a parody voice.`
      : `Invent a brand-new character inspired by ${req.named}: a new name and a new look that riff on what's fun about them, clearly not the same character.`;
  const task = current
    ? req.part === 'all'
      ? `Recreate this host from scratch. Keep the emoji ${current.emoji}${current.origin.kind === 'play' ? ` and the name ${current.name}` : ''}.\n${describe(current)}`
      : `Rewrite only the ${req.part === 'lines' ? 'voice and lines' : req.part === 'portrait' ? 'look (portrait, colours, palette, mode)' : 'animations'} of this host and keep everything else as it is:\n${describe(current)}`
    : `Create a new resident host for a developer's coding dashboard, based on "${req.named}".\n${who}`;
  const sections = [
    keys.some((k) => ['voice', 'asks', 'spinner'].includes(k)) ? LINES : '',
    keys.includes('portrait') ? LOOK : '',
    keys.includes('motion') ? MOTION : '',
  ].filter(Boolean);
  const identity = keys.includes('name')
    ? `Identity:\n- "name": ≤ 40 characters.\n- "emoji": exactly one emoji for this host. It must not be any of: ${others.map((c) => c.emoji).join(' ') || '(none yet)'} or 🦋.`
    : '';
  return [
    'You design resident "hosts" for a developer\'s coding dashboard: a cartoon character who signs off some of Claude\'s replies with a one-line aside, frames its questions, and animates in the UI.',
    task,
    RULES,
    identity,
    ...sections,
    req.feedback ? `The user's note for this version: "${req.feedback}". Follow it within the rules.` : '',
    `Answer with one JSON object with exactly these keys: ${keys.map((k) => `"${k}"`).join(', ')}${keys.includes('badge') ? ' ("badge" optional)' : ''}. No prose, no code fences.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What to send after an answer failed validation: the same prompt plus the problems. */
export const retryPrompt = (prompt: string, errors: string[]) =>
  `${prompt}\n\nYour previous answer had these problems:\n${errors.map((e) => `- ${e}`).join('\n')}\nAnswer again with the complete JSON object, fixing all of them.`;
