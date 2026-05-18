/**
 * Provider-agnostic LLM judge interface + implementations.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export interface JudgeLlmRequest {
  readonly system: string;
  readonly userPrompt: string;
  readonly maxTokens: number;
}

export interface JudgeLlm {
  complete(request: JudgeLlmRequest): Promise<string>;
}

export class AnthropicJudge implements JudgeLlm {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async complete(request: JudgeLlmRequest): Promise<string> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: 'user', content: request.userPrompt }],
    });
    return response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }
}

export class OpenAIJudge implements JudgeLlm {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(model: string, apiKey: string) {
    this.model = model;
    this.client = new OpenAI({ apiKey });
  }

  async complete(request: JudgeLlmRequest): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.model,
      max_completion_tokens: request.maxTokens,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.userPrompt },
      ],
    });
    return response.choices[0]?.message.content ?? '';
  }
}

/** Create the appropriate judge LLM based on provider. */
export function createJudgeLlm(provider: 'anthropic' | 'openai', model: string, apiKey: string): JudgeLlm {
  if (provider === 'anthropic') {
    return new AnthropicJudge(model, apiKey);
  }
  return new OpenAIJudge(model, apiKey);
}
