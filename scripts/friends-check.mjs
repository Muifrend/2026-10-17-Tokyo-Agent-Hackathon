import { _electron as electron } from 'playwright';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const desktop = await electron.launch({
  executablePath: path.resolve('out/Goal Coach-darwin-arm64/Goal Coach.app/Contents/MacOS/goal-coach'),
  env, cwd: process.cwd(), timeout: 30000,
});
try {
  const page = await desktop.firstWindow();
  await page.waitForFunction(() => !!window.coach);
  await page.waitForFunction(async () => (await window.coach.getState()).ready, { timeout: 30000 });
  const before = await page.evaluate(() => window.coach.getState());
  await page.getByRole('button', { name: 'Friends', exact: true }).click();
  await page.getByRole('table', { name: 'Leaderboard' }).waitFor({ timeout: 15000 });
  const live = await page.evaluate(() => window.coach.getFriends());
  if (live.status !== 'ready' || !live.rows.some(r => r.name.toLowerCase() === 'andrew')) throw new Error('Live shared leaderboard missing Andrew');
  await page.getByRole('cell', { name: /Andrew.*\(you\)/ }).waitFor();
  await page.getByRole('heading', { name: 'Goals', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Brainstorms', exact: true }).waitFor();
  const after = await page.evaluate(() => window.coach.getState());
  if (JSON.stringify(before.session) !== JSON.stringify(after.session)) throw new Error('Friends changed focus state');
  if (JSON.stringify(before.goals) !== JSON.stringify(after.goals) || JSON.stringify(before.messages) !== JSON.stringify(after.messages)) throw new Error('Friends changed coach records');
  const positions = await page.locator('.friends-section,.goals-section,.brainstorms-section').evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().top));
  if (!(positions[0] < positions[1] && positions[1] < positions[2])) throw new Error('Sidebar order incorrect');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/friends-live.png' });
  const savedChat = before.conversations.find(c => c.kind === 'brainstorm' && before.messages.some(m => m.conversationId === c.id && m.role === 'reminder'));
  if (savedChat) {
    await page.getByRole('button', { name: savedChat.title, exact: true }).click();
    if (await page.locator('.msg.reminder').count()) throw new Error('Reminders clutter the interview');
    const interview = before.messages.filter(m => m.conversationId === savedChat.id && m.role !== 'reminder');
    if (await page.locator('.msgs .msg').count() !== interview.length) throw new Error('Interview messages missing');
    const savedAfter = await page.evaluate(() => window.coach.getState());
    if (savedAfter.messages.length !== before.messages.length) throw new Error('Reminder history was deleted');
    await page.screenshot({path:'artifacts/chat-clean.png'});
  }
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await page.getByRole('heading', { name: 'What goals are you trying to achieve?', exact: true }).waitFor();
  console.log('Packaged app: live shared leaderboard, Andrew, sidebar order, preserved coaching records and navigation passed.');
} finally { await desktop.close(); }
