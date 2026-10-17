import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AIClient, analysisSchema, interviewSchema } from '../src/main/ai';
import type { Goal } from '../src/shared/types';

const MODEL = 'test-model';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function chatResponse(content: unknown): Response {
  return jsonResponse({
    choices: [{ message: { content } }],
  });
}

function modelsResponse(entry: Record<string, unknown>): Response {
  return jsonResponse({ data: [{ id: MODEL, ...entry }] });
}

const validAnalysis = {
  phoneDetected: false,
  verdict: 'on_track',
  confidence: 0.9,
  reason: 'Editor is open with thesis text.',
  reminderText: 'Keep writing.',
};

const validInterview = {
  reply: 'What does done look like?',
  title: 'Thesis',
  goals: [{ id: null, title: 'Thesis', outcome: '', onTrack: [], offTrack: [] }],
};

const dummyGoal: Goal = {
  id: 'g1',
  title: 'Write thesis',
  outcome: 'Draft submitted',
  onTrack: ['writing'],
  offTrack: ['social media'],
  ready: true,
  sourceConversationId: 'c1',
  conversationId: 'c2',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('AIClient', () => {
  const env = { AIAND_API_KEY: ' test-key ', AIAND_MODEL: MODEL };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('validates the configured model and caches reasoning level', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'], reasoning_efforts: ['high', 'low'] }))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validInterview)));
    const client = new AIClient(env);
    await client.init();
    const result = await client.interview([], []);
    expect(result.reply).toBe(validInterview.reply);
    expect(result.goals[0].title).toBe('Thesis');

    const initCall = fetchMock.mock.calls[0];
    expect(initCall[0]).toContain('/models');
    expect(initCall[1].headers.Authorization).toBe('Bearer test-key');

    const chatCall = fetchMock.mock.calls[1];
    expect(chatCall[0]).toContain('/chat/completions');
    const body = JSON.parse(chatCall[1].body);
    expect(body.reasoning_effort).toBe('low');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(JSON.stringify(body.response_format.json_schema.schema)).toContain('additionalProperties":false');
  });

  it('omits reasoning_effort when the model advertises none', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validInterview)));
    const client = new AIClient(env);
    await client.init();
    await client.interview([], []);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.reasoning_effort).toBeUndefined();
  });

  it('sends screen and camera frames as labeled inline images', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'], reasoning_efforts: ['low'] }))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validAnalysis)));
    const client = new AIClient(env);
    await client.init();
    await client.analyze(dummyGoal, { screen: 'data:image/png;base64,AAA', camera: 'data:image/png;base64,BBB' },undefined,[{id:'action',goalId:dummyGoal.id,kind:'action',text:'Draft the introduction',parentId:null,sourceMessageId:null,createdAt:'t',updatedAt:'t'}]);

    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    const parts = body.messages[1].content;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('screen');
    expect(parts[0].text).toContain(dummyGoal.title);
    expect(parts[0].text).toContain('Draft the introduction');
    const images = parts.filter((p: { type: string }) => p.type === 'image_url');
    expect(images).toHaveLength(2);
    expect(images[0].image_url.url).toBe('data:image/png;base64,AAA');
    expect(images[1].image_url.url).toBe('data:image/png;base64,BBB');
  });

  it('uses the one-frame phone-presence policy and requires a phone detection flag', async () => {
    fetchMock.mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ ...validAnalysis, phoneDetected: true, verdict: 'off_track', reminderText: 'Stop using your phone.' })));
    const client = new AIClient(env);
    await client.init();
    const result = await client.analyze(dummyGoal, { screen: 'screen', camera: 'camera' });
    expect(result.phoneDetected).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.response_format.json_schema.schema.required).toContain('phoneDetected');
    expect(body.response_format.json_schema.schema.properties.reminderText.minLength).toBe(1);
    expect(body.response_format.json_schema.schema.properties.reason.minLength).toBe(1);
    expect(body.messages[1].content.filter((p: {type: string}) => p.type === 'image_url')).toHaveLength(2);
    expect(body.messages[0].content).toContain('Stop using your phone.');
    expect(analysisSchema.safeParse(validAnalysis).success).toBe(true);
    const { phoneDetected: _unused, ...missingPhoneFlag } = validAnalysis;
    expect(analysisSchema.safeParse(missingPhoneFlag).success).toBe(false);
  });

  it('rejects malformed structured output with a short error', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(chatResponse('this is not json'));
    const client = new AIClient(env);
    await client.init();
    await expect(client.interview([], [])).rejects.toThrow('AI returned an invalid response');
  });

  it('rejects unknown verdict values', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(
        chatResponse(JSON.stringify({ ...validAnalysis, verdict: 'dancing' }))
      );
    const client = new AIClient(env);
    await client.init();
    await expect(
      client.analyze(dummyGoal, { screen: 'data:image/png;base64,AAA', camera: 'data:image/png;base64,BBB' })
    ).rejects.toThrow('AI returned an invalid response');
  });

  it('rejects out-of-range confidence', () => {
    expect(
      analysisSchema.safeParse({ ...validAnalysis, confidence: 1.5 }).success
    ).toBe(false);
    expect(
      analysisSchema.safeParse({ ...validAnalysis, confidence: Number.NaN }).success
    ).toBe(false);
  });

  it('sanitizes HTTP errors to status only', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'secret server details' }, 500));
    const client = new AIClient(env);
    await expect(client.init()).rejects.toThrow('AI request failed (HTTP 500)');
  });

  it('sanitizes timeout errors', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeoutError);
    const client = new AIClient(env);
    await expect(client.init()).rejects.toThrow('AI request timed out');
  });

  it('interview maps reminder role to assistant', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(validInterview)));
    const client = new AIClient(env);
    await client.init();
    await client.interview([
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'reminder',
        content: 'Stay on task',
        createdAt: '2024-01-01T00:00:00.000Z',
      },
    ], []);
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.messages[1].role).toBe('assistant');
    expect(body.messages[1].content).toBe('Stay on task');
  });

  it('interview validates goal ids against known list prompt', async () => {
    fetchMock
      .mockResolvedValueOnce(modelsResponse({ capabilities: ['vision'] }))
      .mockResolvedValueOnce(
        chatResponse(
          JSON.stringify({
            ...validInterview,
            goals: [{ id: 'g1', title: 'Thesis', outcome: '', onTrack: [], offTrack: [] }],
          })
        )
      );
    const client = new AIClient(env);
    await client.init();
    const res = await client.interview([], [dummyGoal]);
    expect(res.goals[0].id).toBe('g1');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(body.messages[0].content).toContain('g1');
  });

  it('interviewSchema enforces title length and required fields', () => {
    expect(interviewSchema.safeParse({ ...validInterview, title: 'x'.repeat(81) }).success).toBe(false);
    expect(interviewSchema.safeParse({ reply: 'a', goals: [] }).success).toBe(false);
  });
});
