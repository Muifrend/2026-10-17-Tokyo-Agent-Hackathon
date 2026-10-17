import neo4j, { Driver, Session } from 'neo4j-driver';
import { randomUUID } from 'crypto';
import {
  Conversation,
  FocusSession,
  Goal,
  Message,
  Observation,
} from '../shared/types';

export interface Store {
  init(): Promise<void>;
  load(): Promise<{ conversations: Conversation[]; goals: Goal[]; messages: Message[] }>;
  createConversation(c: Conversation): Promise<void>;
  saveTurn(
    conversationId: string,
    user: Message,
    assistant: Message,
    goals: Goal[],
    title: string,
  ): Promise<void>;
  saveSession(s: FocusSession): Promise<void>;
  saveObservation(o: Observation): Promise<void>;
  saveReminder(goal: Goal, text: string): Promise<Message>;
  close(): Promise<void>;
}

function sanitize(_err: unknown): Error { return new Error('Neo4j connection or write failed. Check configuration and retry.'); }

function parseJson<T>(raw: unknown): T {
  if (typeof raw === 'string') return JSON.parse(raw) as T;
  return raw as T;
}

export class Neo4jStore implements Store {
  private driver: Driver | null = null;
  private sessionWrites = new Map<string,Promise<void>>();
  private readonly uri: string;
  private readonly user: string;
  private readonly password: string;
  private readonly database: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    if (!env.NEO4J_URI || !env.NEO4J_USERNAME || !env.NEO4J_PASSWORD) {
      throw new Error('Missing required database configuration');
    }
    this.uri = env.NEO4J_URI;
    this.user = env.NEO4J_USERNAME;
    this.password = env.NEO4J_PASSWORD;
    this.database = env.NEO4J_DATABASE || 'neo4j';
  }

  private session(): Session {
    if (!this.driver) throw new Error('Store not initialized');
    return this.driver.session({ database: this.database });
  }

  async init(): Promise<void> {
    try {
      this.driver = neo4j.driver(
        this.uri,
        neo4j.auth.basic(this.user, this.password), { connectionTimeout: 10000, maxTransactionRetryTime: 5000 },
      );
      await this.driver.verifyConnectivity();

      const session = this.session();
      try {
        const constraints = [
          'TGCConversation',
          'TGCMessage',
          'TGCGoal',
          'TGCFocusSession',
          'TGCObservation',
        ];
        for (const label of constraints) {
          await session.run(
            `CREATE CONSTRAINT IF NOT EXISTS FOR (n:${label}) REQUIRE n.id IS UNIQUE`,
          );
        }

        // Mark only active sessions of THIS instance as interrupted.
        const result = await session.run(
          `MATCH (f:TGCFocusSession) WHERE f.json CONTAINS '"status":"active"' RETURN f.id AS id, f.json AS json`,
        );
        for (const record of result.records) {
          const id = record.get('id') as string;
          const raw = record.get('json');
          let parsed: FocusSession;
          try {
            parsed = parseJson<FocusSession>(raw);
          } catch {
            continue;
          }
          if (parsed.status !== 'active') continue;
          parsed.status = 'interrupted';
          if (!parsed.endedAt) parsed.endedAt = new Date().toISOString();
          await session.run(
            `MATCH (f:TGCFocusSession {id: $id}) SET f.json = $json, f.status = $status`,
            { id, json: JSON.stringify(parsed), status: parsed.status },
          );
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      throw sanitize(err);
    }
  }

  async load(): Promise<{ conversations: Conversation[]; goals: Goal[]; messages: Message[] }> {
    const session = this.session();
    try {
      const convRes = await session.run('MATCH (c:TGCConversation) RETURN c.json AS json');
      const goalRes = await session.run('MATCH (g:TGCGoal) RETURN g.json AS json');
      const msgRes = await session.run('MATCH (m:TGCMessage) RETURN m.json AS json');
      const conversations = convRes.records
        .map((r) => parseJson<Conversation>(r.get('json')))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const goals = goalRes.records
        .map((r) => parseJson<Goal>(r.get('json')))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const messages = msgRes.records
        .map((r) => parseJson<Message>(r.get('json')))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      return { conversations, goals, messages };
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  async createConversation(c: Conversation): Promise<void> {
    const session = this.session();
    try {
      await session.run(
        `MERGE (c:TGCConversation {id: $id}) SET c.json = $json, c.kind = $kind, c.createdAt = $createdAt`,
        { id: c.id, json: JSON.stringify(c), kind: c.kind, createdAt: c.createdAt },
      );
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  async saveTurn(
    conversationId: string,
    user: Message,
    assistant: Message,
    goals: Goal[],
    title: string,
  ): Promise<void> {
    const session = this.session();
    try {
      await session.executeWrite(async (tx) => {
        for (const m of [user, assistant]) {
          await tx.run(
            `MERGE (m:TGCMessage {id: $id})
             SET m.json = $json, m.conversationId = $conversationId, m.role = $role, m.createdAt = $createdAt
             WITH m
             MATCH (c:TGCConversation {id: $conversationId})
             MERGE (c)-[:HAS_MESSAGE]->(m)`,
            {
              id: m.id,
              json: JSON.stringify(m),
              conversationId: m.conversationId,
              role: m.role,
              createdAt: m.createdAt,
            },
          );
        }

        const current = await tx.run('MATCH (c:TGCConversation {id: $id}) RETURN c.json AS json', {id: conversationId});
        if (!current.records[0]) throw new Error('Conversation not found');
        const conversation = parseJson<Conversation>(current.records[0].get('json'));
        conversation.title = title || conversation.title;
        await tx.run('MATCH (c:TGCConversation {id: $id}) SET c.json = $json', {id:conversationId,json:JSON.stringify(conversation)});

        for (const goal of goals) {
          await this.upsertGoalInTx(tx, goal);
        }
      });
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  private async upsertGoalInTx(
    tx: any,
    goal: Goal,
  ): Promise<void> {
    await tx.run(
      `MERGE (g:TGCGoal {id: $id})
       SET g.json = $json, g.createdAt = coalesce(g.createdAt, $createdAt), g.updatedAt = $updatedAt
       WITH g
       MATCH (conv:TGCConversation {id: $conversationId})
       MERGE (conv)-[:PRODUCED_GOAL]->(g)
       `,
      {
        id: goal.id,
        json: JSON.stringify(goal),
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        conversationId: goal.sourceConversationId,
      },
    );

    // Goal-kind conversation (the one tracking the goal).
    await tx.run(
      `MERGE (gc:TGCConversation {id: $gcId})
       ON CREATE SET
         gc.json = $gcJson,
         gc.kind = 'goal',
         gc.createdAt = $createdAt,
         gc.title = $gcTitle
       WITH gc
       MATCH (g:TGCGoal {id: $goalId})
       MERGE (g)-[:HAS_CONVERSATION]->(gc)
`,
      {
        gcId: goal.conversationId,
        gcTitle: goal.title,
        gcJson: JSON.stringify({
          id: goal.conversationId,
          title: goal.title,
          kind: 'goal',
          goalId: goal.id,
          createdAt: goal.createdAt,
        } satisfies Conversation),
        createdAt: goal.createdAt,
        goalId: goal.id,
      },
    );
  }

  async saveSession(s: FocusSession): Promise<void> {
    const snapshot={...s};
    const previous=this.sessionWrites.get(s.id)??Promise.resolve();
    const operation=previous.catch(()=>{}).then(()=>this.writeSession(snapshot));
    this.sessionWrites.set(s.id,operation);
    try {await operation;}finally{if(this.sessionWrites.get(s.id)===operation)this.sessionWrites.delete(s.id);}
  }
  private async writeSession(s: FocusSession): Promise<void> {
    const session = this.session();
    try {
      await session.run(
        `MERGE (f:TGCFocusSession {id: $id})
         SET f.json = $json, f.status = $status
         WITH f
         MATCH (g:TGCGoal {id: $goalId})
         MERGE (f)-[:FOCUSED_ON]->(g)`,
        { id: s.id, json: JSON.stringify(s), status: s.status, goalId: s.goalId },
      );
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  async saveObservation(o: Observation): Promise<void> {
    const session = this.session();
    try {
      await session.run(
        `MERGE (o:TGCObservation {id: $id})
         SET o.json = $json, o.sessionId = $sessionId, o.createdAt = $createdAt
         WITH o
         MATCH (f:TGCFocusSession {id: $sessionId})
         MERGE (f)-[:HAS_OBSERVATION]->(o)`,
        { id: o.id, json: JSON.stringify(o), sessionId: o.sessionId, createdAt: o.createdAt },
      );
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  async saveReminder(goal: Goal, text: string): Promise<Message> {
    const message: Message = {
      id: randomUUID(),
      conversationId: goal.sourceConversationId,
      role: 'reminder',
      content: text,
      createdAt: new Date().toISOString(),
    };
    const session = this.session();
    try {
      await session.run(
        `MERGE (m:TGCMessage {id: $id})
         SET m.json = $json, m.conversationId = $conversationId, m.role = $role, m.createdAt = $createdAt
         WITH m
         MATCH (c:TGCConversation {id: $conversationId})
         MERGE (c)-[:HAS_MESSAGE]->(m)`,
        {
          id: message.id,
          json: JSON.stringify(message),
          conversationId: message.conversationId,
          role: message.role,
          createdAt: message.createdAt,
        },
      );
      return message;
    } catch (err) {
      throw sanitize(err);
    } finally {
      await session.close();
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessionWrites.values()]);
    if (this.driver) {
      try {
        await this.driver.close();
      } catch (err) {
        throw sanitize(err);
      } finally {
        this.driver = null;
      }
    }
  }
}
