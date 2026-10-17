import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

// Renderer regression only: synthetic state, no database, AI, or device capture.
const root = path.resolve('.vite/renderer/main_window');
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const filename = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!filename.startsWith(root + path.sep)) throw new Error('Invalid path');
    const content = await readFile(filename);
    res.setHeader('Content-Type', filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(content);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const stamp = new Date().toISOString();
    const goal = { id: '11111111-1111-4111-8111-111111111111', title: 'Write an essay', outcome: 'Finish a draft', onTrack: [], offTrack: [], ready: false, sourceConversationId: 'source', conversationId: 'goal-chat', createdAt: stamp, updatedAt: stamp };
    const readyGoal = { ...goal, id: '22222222-2222-4222-8222-222222222222', title: 'Ready essay', onTrack: ['Writing'], ready: true };
    const state = { goals: [goal, readyGoal], conversations: [], messages: [], goalDetails: [], session: null, notice: null, ready: true };
    let listener = () => {};
    window.setupCheck = { displayRequests: 0, starts: 0, turns: [], failNext: true };
    window.coach = {
      getState: async () => structuredClone(state),
      onState: fn => { listener = fn; return () => {}; },
      selectGoal: async (_id, displayId) => { if (displayId) window.setupCheck.starts++; return goal.conversationId; },
      listDisplays: async () => { window.setupCheck.displayRequests++; return [{ id: 'screen:1', name: 'Display', thumbnail: '' }]; },
      sendMessage: async (chat, content, requestId) => {
        window.setupCheck.turns.push({ chat, content, requestId });
        if (window.setupCheck.failNext) { window.setupCheck.failNext = false; throw new Error('Test failure'); }
        goal.onTrack = ['Writing']; goal.ready = true;
        listener(structuredClone(state));
      },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.goals-section').getByRole('button', { name: 'Ready essay', exact: true }).click();
  await page.getByRole('dialog', { name: 'Start focus session' }).waitFor();
  assert.equal(await page.getByRole('dialog', { name: 'Finish goal setup' }).count(), 0);
  assert.equal(await page.evaluate(() => window.setupCheck.turns.length), 0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => { window.setupCheck.displayRequests = 0; });
  await page.locator('.goals-section').getByRole('button', { name: 'Write an essay', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Finish goal setup' });
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByText(/on track/i).waitFor();
  assert.equal(await page.evaluate(() => window.setupCheck.displayRequests), 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await dialog.getByRole('textbox').fill('Writing');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await dialog.getByRole('alert').waitFor();
  assert.equal(await dialog.getByRole('textbox').inputValue(), 'Writing');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  const consent = page.getByRole('dialog', { name: 'Start focus session' });
  await consent.waitFor();
  const check = await page.evaluate(() => window.setupCheck);
  assert.equal(check.starts, 0, 'Setup must never start capture without consent');
  assert.equal(check.displayRequests, 1);
  assert.equal(check.turns[0].chat, 'goal-chat');
  assert.equal(check.turns[0].requestId, check.turns[1].requestId, 'Retry must preserve request identity');
  assert.match(check.turns[1].content, /on track/i);
  assert.match(check.turns[1].content, /Writing/);
  assert.deepEqual(await page.evaluate(async () => (await window.coach.getState()).goals[0].offTrack), []);
  await consent.getByRole('button', { name: 'Continue', exact: true }).click();
  await consent.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.setupCheck.starts), 1);
  console.log('Goals without distraction criteria reach focus consent; required setup, retries, scoped updates, and explicit capture consent passed.');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
