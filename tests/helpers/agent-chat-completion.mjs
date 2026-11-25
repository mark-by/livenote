import { randomUUID } from 'node:crypto';

export function chatCompletion(model, message) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', ...message },
      logprobs: null,
      finish_reason: message.tool_calls ? 'tool_calls' : 'stop'
    }]
  };
}
