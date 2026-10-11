import { describe, expect, it, vi } from 'vitest';
import { chatTools } from '../lib/chat/tools';
vi.mock('../lib/chat/queries', () => ({ postsRanked: async () => ({ reach: 1248 }) }));
import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { chatGenerationOptions, validateChatAnswer } from '../lib/chat/generation';

/** Real installed adapter, mocked HTTP only: no free-tier inference. */
describe('Groq OpenAI-compatible tool loop', () => {
  it.each(['1248 accounts reached.', '99999 accounts reached.'])(
    'validates %s against SQL tool evidence',
    async (answer) => {
      const requests: Record<string, unknown>[] = [];
      const groq = createOpenAICompatible({
        name: 'groq',
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: 'test-only',
        fetch: async (url, options) => {
          expect(String(url)).toBe('https://api.groq.com/openai/v1/chat/completions');
          const body = JSON.parse(String(options?.body));
          requests.push(body);
          expect(body.tools).toHaveLength(8);
          expect(body.temperature).toBe(0.4);
          const schema = body.tools.find(
            (t: { function: { name: string } }) => t.function.name === 'getPostsRanked',
          ).function.parameters;
          expect(schema.properties.metric.enum).toContain('reach');
          const final = body.tool_choice === 'none';
          return Response.json({
            id: 'test',
            object: 'chat.completion',
            created: 1,
            model: 'openai/gpt-oss-120b',
            choices: [
              {
                index: 0,
                finish_reason: final ? 'stop' : 'tool_calls',
                message: final
                  ? { role: 'assistant', content: answer }
                  : {
                      role: 'assistant',
                      content: null,
                      tool_calls: [
                        {
                          id: 'lookup',
                          type: 'function',
                          function: {
                            name: 'getPostsRanked',
                            arguments: '{"metric":"reach","limit":10,"sinceDays":180}',
                          },
                        },
                      ],
                    },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
          });
        },
      });
      const tools = chatTools(1);
      const result = await generateText({
        model: groq('openai/gpt-oss-120b'),
        tools,
        system: 'Use evidence.',
        messages: [
          { role: 'assistant', content: 'Which measure?' },
          { role: 'user', content: 'Highest views?' },
        ],
        ...chatGenerationOptions<typeof tools>(2, 'Use evidence.'),
        maxRetries: 0,
        temperature: 0.4,
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({ model: 'openai/gpt-oss-120b', tool_choice: 'required' });
      expect(requests[1]).toMatchObject({ tool_choice: 'none' });
      expect(JSON.stringify(requests[1]?.messages)).toContain('1248');
      const validated = validateChatAnswer(
        result.text,
        result.steps.flatMap((step) => step.toolResults.map((r) => r.output)),
      );
      expect(validated.dropped).toHaveLength(answer === '1248 accounts reached.' ? 0 : 1);
      expect(result.totalUsage.inputTokens).toBe(20);
    },
  );
});
