'use strict';
// Human-like interaction primitives for Playwright pages.

const lastPos = new WeakMap();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.random() * (max - min) + min;
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

async function think(min = 600, max = 2400) {
  await sleep(randInt(min, max));
}

function viewportOf(page) {
  return page.viewportSize() || { width: 1280, height: 720 };
}

// Move the cursor along a slightly curved, jittered path (quadratic Bezier) to (x, y).
async function moveMouse(page, x, y) {
  const vp = viewportOf(page);
  const from = lastPos.get(page) || { x: rand(0, vp.width), y: rand(0, vp.height) };
  const steps = randInt(18, 34);
  // control point offset to create a gentle arc
  const cx = (from.x + x) / 2 + rand(-60, 60);
  const cy = (from.y + y) / 2 + rand(-60, 60);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;
    const px = mt * mt * from.x + 2 * mt * t * cx + t * t * x + rand(-1.2, 1.2);
    const py = mt * mt * from.y + 2 * mt * t * cy + t * t * y + rand(-1.2, 1.2);
    await page.mouse.move(px, py);
    await sleep(rand(3, 13));
  }
  lastPos.set(page, { x, y });
}

// Scroll down (mostly) in human-sized increments, occasionally pausing or scrolling back up.
async function humanScroll(page, { steps = randInt(3, 7) } = {}) {
  for (let i = 0; i < steps; i++) {
    const delta = randInt(220, 620);
    await page.mouse.wheel(0, delta);
    await sleep(rand(350, 1300));
    if (Math.random() < 0.18) {
      await page.mouse.wheel(0, -randInt(80, 240));
      await sleep(rand(250, 700));
    }
  }
}

async function pointInBox(box) {
  // aim for the central area with some natural offset
  const x = box.x + box.width * rand(0.3, 0.7);
  const y = box.y + box.height * rand(0.3, 0.7);
  return { x, y };
}

// Reliable, human-ish click: scroll into view, move cursor over the element, pause, click.
async function moveAndClick(page, locator, { timeout = 8000 } = {}) {
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await sleep(rand(120, 480));
  const box = await locator.boundingBox();
  if (box) {
    const p = await pointInBox(box);
    await moveMouse(page, p.x, p.y);
    await sleep(rand(80, 280));
  }
  await locator.click({ timeout });
}

async function hover(page, locator, { timeout = 6000 } = {}) {
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  const box = await locator.boundingBox();
  if (box) {
    const p = await pointInBox(box);
    await moveMouse(page, p.x, p.y);
  }
  await locator.hover({ timeout }).catch(() => {});
  await sleep(rand(300, 900));
}

// Type with per-character variable delay, after focusing the field like a person.
async function humanType(page, locator, text, { timeout = 8000 } = {}) {
  await locator.scrollIntoViewIfNeeded({ timeout }).catch(() => {});
  await moveAndClick(page, locator, { timeout }).catch(async () => { await locator.click({ timeout }).catch(() => {}); });
  await sleep(rand(120, 360));
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await sleep(rand(28, 145));
    if (Math.random() < 0.03) await sleep(rand(200, 600)); // occasional pause
  }
}

module.exports = { sleep, rand, randInt, pick, think, moveMouse, humanScroll, moveAndClick, hover, humanType };
